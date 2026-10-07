import { z } from 'zod'

export interface SseEvent {
  type: 'event'
  id: string
  event: string
  data: string
}

export type SseFrame = SseEvent | { type: 'comment'; text: string }

export interface SseParser {
  push(chunk: Uint8Array): SseFrame[]
  finish(): SseFrame[]
  readonly lastEventId: string
  readonly retry: number | undefined
}

/** IDs persist across frames; retry is connection state, not a dispatched event. */
export function createSseParser(): SseParser {
  const decoder = new TextDecoder()
  let line = ''
  let skipLf = false
  let data: string[] = []
  let event = ''
  let id = ''
  let retry: number | undefined
  let finished = false

  function processLine(output: SseFrame[]): void {
    if (line === '') {
      if (data.length)
        output.push({ type: 'event', id, event: event || 'message', data: data.join('\n') })
      data = []
      event = ''
    } else {
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (colon === 0) output.push({ type: 'comment', text: value })
      else if (field === 'data') data.push(value)
      else if (field === 'event') event = value
      else if (field === 'id' && !value.includes('\0')) id = value
      else if (field === 'retry' && /^[0-9]+$/.test(value)) {
        // Clamp enormous valid integers rather than putting Infinity into a timer.
        retry = Math.min(Number(value), Number.MAX_SAFE_INTEGER)
      }
    }
    line = ''
  }

  function parse(text: string): SseFrame[] {
    const output: SseFrame[] = []
    for (const char of text) {
      if (skipLf) {
        skipLf = false
        if (char === '\n') continue
      }
      if (char === '\r' || char === '\n') {
        processLine(output)
        skipLf = char === '\r'
      } else line += char
    }
    return output
  }

  return {
    push(chunk) {
      if (finished) throw new Error('SSE parser is finished')
      return parse(decoder.decode(chunk, { stream: true }))
    },
    finish() {
      if (finished) return []
      finished = true
      const output = parse(decoder.decode())
      // EOF terminates a line, but never supplies the blank line needed to dispatch data.
      if (line) processLine(output)
      data = []
      event = ''
      return output
    },
    get lastEventId() {
      return id
    },
    get retry() {
      return retry
    },
  }
}

export class SseHttpError extends Error {
  readonly status: number
  readonly bodySnippet: string

  constructor(status: number, bodySnippet: string) {
    super(`SSE HTTP response rejected (status ${status})`)
    this.name = 'SseHttpError'
    this.status = status
    this.bodySnippet = bodySnippet.slice(0, 500)
  }
}

export type SseClosed =
  | { reason: 'server_closed'; streamClosed: boolean }
  | { reason: 'aborted' }
  | { reason: 'error'; error: Error }

export interface SseConnection extends AsyncIterable<SseFrame> {
  readonly closed: Promise<SseClosed>
  readonly retry: number | undefined
  abort(): void
}

export interface ConnectSseOptions {
  url: string | URL
  headers?: ConstructorParameters<typeof Headers>[0]
  lastEventId?: string
  signal?: AbortSignal
  fetch?: typeof globalThis.fetch
}

const abortError = () => new Error('SSE aborted')

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function redact(text: string, headers: Headers): string {
  const secrets = [...headers.values()].filter(Boolean)
  const bearer = headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (bearer) secrets.push(bearer)
  for (const secret of secrets.sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(secret, '[redacted]')
  }
  return text
}

async function bodySnippet(
  response: Response,
  headers: Headers,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    // Keep a bounded prefix, allowing enough lookahead to redact a secret crossing the cut.
    const limit = 500 + Math.max(0, ...[...headers.values()].map((value) => value.length))
    while (text.length < limit) {
      const { done, value } = await abortable(reader.read(), signal)
      if (done) {
        text += decoder.decode()
        break
      }
      text += decoder.decode(value, { stream: true })
    }
  } catch (error) {
    if (signal.aborted) throw error
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return redact(text, headers).slice(0, 500)
}

/** Single-use, lazy connection. `closed` settles when iteration finishes. */
export function connectSse(options: ConnectSseOptions): SseConnection {
  const parser = createSseParser()
  const controller = new AbortController()
  const { promise: closed, resolve: settle } = Promise.withResolvers<SseClosed>()

  async function* iterate(): AsyncGenerator<SseFrame> {
    let reason: SseClosed = { reason: 'aborted' }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) controller.abort()
    try {
      if (controller.signal.aborted) return
      const headers = new Headers(options.headers)
      headers.set('Accept', 'text/event-stream')
      if (options.lastEventId !== undefined) {
        if (options.lastEventId) headers.set('Last-Event-ID', options.lastEventId)
        else headers.delete('Last-Event-ID')
      }
      const response = await abortable(
        (options.fetch ?? globalThis.fetch)(options.url, {
          headers,
          signal: controller.signal,
        }),
        controller.signal,
      )
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      if (!response.ok || contentType !== 'text/event-stream') {
        throw new SseHttpError(
          response.status,
          await bodySnippet(response, headers, controller.signal),
        )
      }
      if (!response.body) {
        reason = { reason: 'server_closed', streamClosed: false }
        return
      }
      reader = response.body.getReader()
      while (!controller.signal.aborted) {
        const { done, value } = await abortable(reader.read(), controller.signal)
        const frames = done ? parser.finish() : parser.push(value)
        for (const frame of frames) {
          if (controller.signal.aborted) return
          if (frame.type === 'comment' && frame.text === 'stream closed') {
            reason = { reason: 'server_closed', streamClosed: true }
            yield frame
            return
          }
          yield frame
        }
        if (done) {
          reason = { reason: 'server_closed', streamClosed: false }
          return
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return
      // Fetch implementations may echo request headers in their exceptions; never retain those.
      const safeError = error instanceof SseHttpError ? error : new Error('SSE connection failed')
      reason = { reason: 'error', error: safeError }
      throw safeError
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      controller.abort()
      if (reader) {
        void reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      settle(reason)
    }
  }

  const iterator = iterate()
  return {
    [Symbol.asyncIterator]: () => iterator,
    closed,
    get retry() {
      return parser.retry
    },
    abort() {
      controller.abort()
    },
  }
}

export interface SseTruncated {
  oldestRetainedSeq: number
  requestedSeq: string | undefined
}

export interface SseBackoff {
  initialMs?: number
  maxMs?: number
  maxAttempts?: number
  random?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export interface ResumableSseOptions {
  connect: (lastEventId?: string) => SseConnection | Promise<SseConnection>
  onEvent: (event: SseEvent) => void | Promise<void>
  onTruncated: (signal: SseTruncated) => void | Promise<void>
  signal?: AbortSignal
  lastEventId?: string
  backoff?: SseBackoff
}

export interface ResumableSseResult {
  ended: 'server_closed' | 'aborted' | 'gave_up'
  lastEventId: string | undefined
}

const BackoffSchema = z.object({
  initialMs: z.number().finite().nonnegative().default(500),
  maxMs: z.number().finite().nonnegative().default(10_000),
  maxAttempts: z.int().positive().default(8),
})
const EventEnvelopeSchema = z.object({ event: z.string() })
const TruncatedSchema = z.object({
  event: z.literal('replay.truncated'),
  oldest_retained_seq: z.int().nonnegative(),
})

function truncation(data: string, requestedSeq: string | undefined): SseTruncated | undefined {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return
  }
  const envelope = EventEnvelopeSchema.safeParse(value)
  if (!envelope.success || envelope.data.event !== 'replay.truncated') return
  const parsed = TruncatedSchema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid SSE replay truncation signal')
  return { oldestRetainedSeq: parsed.data.oldest_retained_seq, requestedSeq }
}

// A wrong key (401/403) or an unknown run (404, e.g. after a gateway restart) never succeeds on retry.
// The caller falls back to run-status polling and records a gap. 408 and 429 stay retryable.
function isPermanentHttpError(error: unknown): error is SseHttpError {
  return (
    error instanceof SseHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  )
}

function alreadyDelivered(id: string, previous: string | undefined): boolean {
  if (!id || !previous) return false
  if (/^[0-9]+$/.test(id) && /^[0-9]+$/.test(previous)) return BigInt(id) <= BigInt(previous)
  return id === previous
}

export async function resumableSse(options: ResumableSseOptions): Promise<ResumableSseResult> {
  const backoff = BackoffSchema.parse(options.backoff ?? {})
  const random = options.backoff?.random ?? Math.random
  const wait = options.backoff?.sleep ?? sleep
  let lastEventId = options.lastEventId
  let failures = 0
  let retry: number | undefined
  const result = (ended: ResumableSseResult['ended']): ResumableSseResult => ({
    ended,
    lastEventId,
  })

  while (!options.signal?.aborted) {
    const requestedSeq = lastEventId
    let connection: SseConnection | undefined
    let iterator: AsyncIterator<SseFrame> | undefined
    let networkFailure = false
    try {
      try {
        const pending = Promise.resolve(options.connect(lastEventId)).then((connected) => {
          if (options.signal?.aborted) connected.abort()
          return connected
        })
        connection = await abortable(pending, options.signal)
        iterator = connection[Symbol.asyncIterator]()
      } catch (error) {
        if (isPermanentHttpError(error)) throw error
        networkFailure = true
      }
      while (iterator && connection && !options.signal?.aborted) {
        let next: IteratorResult<SseFrame>
        try {
          next = await abortable(iterator.next(), options.signal)
        } catch (error) {
          if (isPermanentHttpError(error)) throw error
          networkFailure = true
          break
        }
        retry = connection.retry ?? retry
        if (next.done) break
        const frame = next.value
        if (frame.type === 'comment') {
          if (frame.text === 'stream closed') return result('server_closed')
          continue
        }
        // Control frames inherit the parser's ID, so detect them before duplicate suppression.
        const truncated = truncation(frame.data, requestedSeq)
        if (truncated) await options.onTruncated(truncated)
        else if (!alreadyDelivered(frame.id, lastEventId)) {
          await options.onEvent(frame)
          failures = 0
          lastEventId = frame.id || undefined
        }
      }
      if (options.signal?.aborted) return result('aborted')
      if (connection && !networkFailure) {
        const closed = await abortable(connection.closed, options.signal)
        if (closed.reason === 'aborted') return result('aborted')
        if (closed.reason === 'server_closed' && closed.streamClosed) return result('server_closed')
      }
    } catch (error) {
      if (options.signal?.aborted) return result('aborted')
      throw error
    } finally {
      retry = connection?.retry ?? retry
      connection?.abort()
      if (iterator?.return) void iterator.return().catch(() => {})
    }
    if (options.signal?.aborted) return result('aborted')
    failures++
    if (failures >= backoff.maxAttempts) return result('gave_up')
    const base = Math.min(backoff.maxMs, (retry ?? backoff.initialMs) * 2 ** (failures - 1))
    const ms = Math.round(Math.min(backoff.maxMs, base * (0.8 + random() * 0.4)))
    try {
      await abortable(wait(ms, options.signal), options.signal)
    } catch (error) {
      if (options.signal?.aborted) return result('aborted')
      throw error
    }
  }
  return result('aborted')
}
