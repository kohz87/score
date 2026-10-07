import { readFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import {
  connectSse,
  createSseParser,
  resumableSse,
  SseHttpError,
  type SseConnection,
  type SseFrame,
} from '../../../src/hermes/live/index.ts'

const encoder = new TextEncoder()
const url = 'http://localhost/p/builder/v1/runs/example/events'
const event = (data: string, id = '', name = 'message'): SseFrame => ({
  type: 'event',
  id,
  event: name,
  data,
})
const comment = (text: string): SseFrame => ({ type: 'comment', text })
const wireEvent = (id: string) => `id: ${id}\ndata: {"event":"message.delta","seq":${id}}\n\n`

function parse(text: string): SseFrame[] {
  const parser = createSseParser()
  return [...parser.push(encoder.encode(text)), ...parser.finish()]
}

async function collect(connection: SseConnection): Promise<SseFrame[]> {
  const frames: SseFrame[] = []
  for await (const frame of connection) frames.push(frame)
  return frames
}

function response(text: string, options: { disconnect?: boolean; open?: boolean } = {}): Response {
  let sent = false
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(encoder.encode(text))
          return
        }
        if (options.disconnect) controller.error(new Error('socket disconnected'))
        else if (!options.open) controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  )
}

function fromText(text: string, options?: Parameters<typeof response>[1]): SseConnection {
  return connectSse({ url, fetch: async () => response(text, options) })
}

afterEach(() => vi.useRealTimers())

describe('SSE parser', () => {
  test.each(['\n', '\r', '\r\n'])('dispatches with %j line endings', (eol) => {
    expect(parse(`id: 0${eol}data: first${eol}data: second${eol}${eol}`)).toEqual([
      event('first\nsecond', '0'),
    ])
  })

  test('dispatches CR immediately and skips a following LF in the next chunk', () => {
    const parser = createSseParser()
    expect(parser.push(encoder.encode('data: hello\r\r'))).toEqual([event('hello')])
    expect(parser.push(encoder.encode('\ndata: again\r\n\r\n'))).toEqual([event('again')])
    expect(parser.finish()).toEqual([])
  })

  test('strips only the leading BOM and streams split UTF-8 characters', () => {
    const bytes = encoder.encode('\uFEFFdata: café 🐈\uFEFF\n\n')
    const parser = createSseParser()
    const output = [...bytes].flatMap((byte) => parser.push(Uint8Array.of(byte)))
    expect([...output, ...parser.finish()]).toEqual([event('café 🐈\uFEFF')])
  })

  test('removes exactly one optional space and preserves tabs and colons', () => {
    expect(parse('data:value\ndata: value\ndata:  value:more\ndata:\tvalue\n\n')).toEqual([
      event('value\nvalue\n value:more\n\tvalue'),
    ])
  })

  test('surfaces comments without disturbing a pending event', () => {
    expect(parse(': open\ndata: a\n:keepalive\n:  spaces\n:\ndata: b\n\n: stream closed')).toEqual([
      comment('open'),
      comment('keepalive'),
      comment(' spaces'),
      comment(''),
      event('a\nb'),
      comment('stream closed'),
    ])
  })

  test('ignores unknown fields and compares field names literally', () => {
    expect(parse('unknown: x\nData: ignored\ndata: yes\n\n')).toEqual([event('yes')])
  })

  test('persists IDs, ignores NUL IDs, and clears IDs without a colon', () => {
    expect(
      parse('id: first\ndata: a\n\nid: bad\0id\ndata: b\n\ndata: c\n\nid\ndata: d\n\n'),
    ).toEqual([event('a', 'first'), event('b', 'first'), event('c', 'first'), event('d')])
  })

  test('ID-only blocks affect following events without dispatching data', () => {
    const parser = createSseParser()
    expect(parser.push(encoder.encode('id: cursor\n\n'))).toEqual([])
    expect(parser.lastEventId).toBe('cursor')
    expect(parser.push(encoder.encode('data: next\n\n'))).toEqual([event('next', 'cursor')])
  })

  test('uses the last event type and resets it even after an empty block', () => {
    expect(
      parse(
        'event: ignored\n\nevent: first\nevent: custom\ndata: a\n\ndata: b\n\nevent:\ndata: c\n\n',
      ),
    ).toEqual([event('a', '', 'custom'), event('b'), event('c')])
  })

  test('empty data fields dispatch; blocks with no data do not', () => {
    expect(parse('\nunknown\n\ndata\n\ndata:\ndata\n\n')).toEqual([event(''), event('\n')])
  })

  test.each(['', '-1', '+1', '1.5', '1x', ' 12', '12 ', '\t12', '１２'])(
    'ignores invalid retry %j',
    (value) => {
      const parser = createSseParser()
      parser.push(encoder.encode(`retry: 123\nretry: ${value}\n\n`))
      expect(parser.retry).toBe(123)
    },
  )

  test('accepts zero and leading zeros in retry without dispatching a frame', () => {
    const parser = createSseParser()
    expect(parser.push(encoder.encode('retry: 00025\n'))).toEqual([])
    expect(parser.retry).toBe(25)
    parser.push(encoder.encode('retry: 0\n'))
    expect(parser.retry).toBe(0)
    parser.push(encoder.encode(`retry: ${'9'.repeat(400)}\n`))
    expect(parser.retry).toBe(Number.MAX_SAFE_INTEGER)
  })

  test.each(['data: lost', 'data: lost\n', 'data: lost\r\n'])(
    'discards incomplete data at EOF: %j',
    (text) => {
      expect(parse(text)).toEqual([])
    },
  )

  test('flushes malformed trailing UTF-8 without dispatching pending data', () => {
    const parser = createSseParser()
    expect(parser.push(encoder.encode(': comment '))).toEqual([])
    expect(parser.push(Uint8Array.of(0xc3))).toEqual([])
    expect(parser.finish()).toEqual([comment('comment �')])
    expect(parser.finish()).toEqual([])
    expect(() => parser.push(new Uint8Array())).toThrow('finished')
  })

  test('every byte split and one-byte chunks produce identical frames and parser state', () => {
    const bytes = encoder.encode(
      '\uFEFF: open\r\nid: 0\rdata: café 🐈\r\ndata: two\n\nretry: 00012\r\nevent: custom\rdata\r\rid: bad\0id\ndata: last\n\n: stream closed\r\n',
    )
    const expected = [
      comment('open'),
      event('café 🐈\ntwo', '0'),
      event('', '0', 'custom'),
      event('last', '0'),
      comment('stream closed'),
    ]
    for (let offset = 0; offset <= bytes.length; offset++) {
      const parser = createSseParser()
      const frames = [
        ...parser.push(bytes.subarray(0, offset)),
        ...parser.push(bytes.subarray(offset)),
        ...parser.finish(),
      ]
      expect(frames, `byte split ${offset}`).toEqual(expected)
      expect(parser.lastEventId).toBe('0')
      expect(parser.retry).toBe(12)
    }
    const parser = createSseParser()
    expect(
      [...bytes].flatMap((byte) => parser.push(Uint8Array.of(byte))).concat(parser.finish()),
    ).toEqual(expected)
  })

  test('replays every recorded run sequence and JSON event name', () => {
    const fixture = z
      .array(
        z.object({ id: z.string(), seq: z.int().nonnegative(), event: z.string() }).passthrough(),
      )
      .parse(
        JSON.parse(
          readFileSync(
            new URL('../../fixtures/hermes/l2-run-events.json', import.meta.url),
            'utf8',
          ),
        ),
      )
    const wire =
      ': open\n' +
      fixture.map((item) => `id: ${item.id}\ndata: ${JSON.stringify(item)}\n\n`).join('') +
      ': stream closed\n'
    const parser = createSseParser()
    const frames = [...encoder.encode(wire)]
      .flatMap((byte) => parser.push(Uint8Array.of(byte)))
      .concat(parser.finish())
    const decoded = frames
      .filter((frame) => frame.type === 'event')
      .map((frame) => {
        const data = z.object({ seq: z.int(), event: z.string() }).parse(JSON.parse(frame.data))
        return { id: frame.id, ...data }
      })
    expect(decoded).toEqual(fixture.map(({ id, seq, event }) => ({ id, seq, event })))
    expect(decoded).toHaveLength(68)
  })
})

describe('SSE connection', () => {
  test('sends auth, Accept, and Last-Event-ID without mutating supplied headers', async () => {
    const headers = new Headers({ Authorization: 'Bearer example-key' })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(': stream closed\n'))
    const connection = connectSse({ url, headers, lastEventId: '0', fetch })
    expect(fetch).not.toHaveBeenCalled()
    expect(await collect(connection)).toEqual([comment('stream closed')])
    const sent = new Headers(fetch.mock.calls[0]?.[1]?.headers)
    expect(sent.get('authorization')).toBe('Bearer example-key')
    expect(sent.get('accept')).toBe('text/event-stream')
    expect(sent.get('last-event-id')).toBe('0')
    expect(headers.has('last-event-id')).toBe(false)
    expect(await connection.closed).toEqual({ reason: 'server_closed', streamClosed: true })
  })

  test('an explicitly empty resume ID clears a supplied Last-Event-ID', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(''))
    await collect(connectSse({ url, headers: { 'Last-Event-ID': 'old' }, lastEventId: '', fetch }))
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('last-event-id')).toBe(false)
  })

  test.each([
    { status: 401, type: 'text/event-stream' },
    { status: 200, type: 'application/json' },
    { status: 200, type: 'text/event-streamish' },
    { status: 200, type: '' },
  ])(
    'rejects status/content type $status $type with a typed, bounded, redacted error',
    async ({ status, type }) => {
      const secret = 'example-private-key'
      const connection = connectSse({
        url,
        headers: { Authorization: `Bearer ${secret}`, 'X-Private': 'private-value' },
        fetch: async () =>
          new Response(`Bearer ${secret} private-value ${'x'.repeat(700)}`, {
            status,
            headers: { 'content-type': type },
          }),
      })
      let caught: unknown
      try {
        await collect(connection)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(SseHttpError)
      const error = caught as SseHttpError
      expect(error.status).toBe(status)
      expect(error.bodySnippet).toHaveLength(500)
      expect(JSON.stringify(error)).not.toContain(secret)
      expect(JSON.stringify(error)).not.toContain('private-value')
      expect(error.message).not.toContain(secret)
      expect(await connection.closed).toEqual({ reason: 'error', error })
    },
  )

  test('redacts a bearer key crossing the snippet boundary', async () => {
    const key = 'example-secret-key'
    const connection = connectSse({
      url,
      headers: { authorization: `Bearer ${key}` },
      fetch: async () => new Response('x'.repeat(495) + key, { status: 403 }),
    })
    await expect(collect(connection)).rejects.toMatchObject({
      bodySnippet: 'x'.repeat(495) + '[reda',
    })
  })

  test('cancels a rejected response after reading a bounded prefix', async () => {
    const cancel = vi.fn()
    const connection = connectSse({
      url,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('x'.repeat(700)))
            },
            cancel,
          }),
          { status: 500 },
        ),
    })
    await expect(collect(connection)).rejects.toBeInstanceOf(SseHttpError)
    expect(cancel).toHaveBeenCalledOnce()
  })

  test('keeps the typed HTTP status when the rejected body also fails', async () => {
    const connection = connectSse({
      url,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('Bearer private-key'))
            },
          }),
          { status: 403 },
        ),
    })
    await expect(collect(connection)).rejects.toMatchObject({
      name: 'SseHttpError',
      status: 403,
      bodySnippet: '',
    })
    expect(await connection.closed).toMatchObject({ reason: 'error' })
  })

  test('invalid header errors settle closed without exposing header values', async () => {
    const connection = connectSse({
      url,
      headers: { Authorization: 'Bearer private-key\ninvalid' },
    })
    await expect(collect(connection)).rejects.toThrow('SSE connection failed')
    expect(JSON.stringify(await connection.closed)).not.toContain('private-key')
  })

  test('parses the client response incrementally across every UTF-8 byte', async () => {
    const bytes = [
      ...encoder.encode('\uFEFF: open\r\nid: 0\r\ndata: café 🐈\r\n\r\n: stream closed\r\n'),
    ]
    const connection = connectSse({
      url,
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              const byte = bytes.shift()
              if (byte === undefined) controller.close()
              else controller.enqueue(Uint8Array.of(byte))
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    })
    expect(await collect(connection)).toEqual([
      comment('open'),
      event('café 🐈', '0'),
      comment('stream closed'),
    ])
    expect(await connection.closed).toEqual({ reason: 'server_closed', streamClosed: true })
  })

  test('plain EOF closes while retaining the distinction needed for reconnection', async () => {
    const connection = fromText('data: first\n\ndata: incomplete')
    expect(await collect(connection)).toEqual([event('first')])
    expect(await connection.closed).toEqual({ reason: 'server_closed', streamClosed: false })
  })

  test('the close comment stops an open body and cancels its reader', async () => {
    const cancel = vi.fn()
    const connection = connectSse({
      url,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(': stream closed\n'))
            },
            cancel,
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    })
    expect(await collect(connection)).toEqual([comment('stream closed')])
    expect(await connection.closed).toEqual({ reason: 'server_closed', streamClosed: true })
    expect(cancel).toHaveBeenCalledOnce()
  })

  test('sanitizes network errors, including errors from a body reader', async () => {
    for (const fetch of [
      async () => {
        throw new Error('Bearer secret')
      },
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('Bearer secret'))
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    ]) {
      const connection = connectSse({ url, fetch })
      await expect(collect(connection)).rejects.toThrow('SSE connection failed')
      expect(JSON.stringify(await connection.closed)).not.toContain('secret')
    }
  })

  test('pre-abort avoids fetching', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetch = vi.fn<typeof globalThis.fetch>()
    const connection = connectSse({ url, signal: controller.signal, fetch })
    expect(await collect(connection)).toEqual([])
    expect(await connection.closed).toEqual({ reason: 'aborted' })
    expect(fetch).not.toHaveBeenCalled()
  })

  test('abort interrupts a pending fetch even when a fake fetch ignores the signal', async () => {
    const controller = new AbortController()
    const connection = connectSse({
      url,
      signal: controller.signal,
      fetch: () => new Promise<Response>(() => {}),
    })
    const frames = collect(connection)
    controller.abort('Bearer private-abort-reason')
    expect(await frames).toEqual([])
    expect(await connection.closed).toEqual({ reason: 'aborted' })
  })

  test('abort cancels a pending body read', async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    )
    const connection = connectSse({ url, signal: controller.signal, fetch })
    const frames = collect(connection)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    controller.abort()
    expect(await frames).toEqual([])
    expect(await connection.closed).toEqual({ reason: 'aborted' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  test('breaking iteration releases the reader and settles closed', async () => {
    const connection = fromText('data: first\n\n', { open: true })
    for await (const frame of connection) {
      expect(frame).toEqual(event('first'))
      break
    }
    expect(await connection.closed).toEqual({ reason: 'aborted' })
  })
})

describe('resumable SSE', () => {
  test.each(['disconnect', 'eof'])(
    'resumes after %s with the last ID and suppresses replayed duplicates',
    async (end) => {
      const connect = vi.fn((lastEventId?: string) =>
        fromText(
          lastEventId === undefined
            ? wireEvent('0') + wireEvent('1')
            : wireEvent('0') + wireEvent('1') + wireEvent('2') + ': stream closed\n',
          { disconnect: lastEventId === undefined && end === 'disconnect' },
        ),
      )
      const onEvent = vi.fn()
      const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {})
      expect(
        await resumableSse({
          connect,
          onEvent,
          onTruncated: vi.fn(),
          backoff: { sleep, random: () => 0.5 },
        }),
      ).toEqual({ ended: 'server_closed', lastEventId: '2' })
      expect(connect.mock.calls).toEqual([[undefined], ['1']])
      expect(onEvent.mock.calls.map(([frame]) => frame.id)).toEqual(['0', '1', '2'])
      expect(sleep).toHaveBeenCalledWith(500, undefined)
    },
  )

  test('permanent HTTP errors fail fast; 429 is retried', async () => {
    const respond = (status: number) =>
      vi.fn(() =>
        connectSse({
          url: 'http://hermes.test/v1/runs/run_x/events',
          headers: { Authorization: 'Bearer secret-key' },
          fetch: async () => new Response('nope', { status }),
        }),
      )
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {})
    for (const status of [401, 403, 404]) {
      const connect = respond(status)
      await expect(
        resumableSse({ connect, onEvent: vi.fn(), onTruncated: vi.fn(), backoff: { sleep } }),
      ).rejects.toMatchObject({ name: 'SseHttpError', status })
      expect(connect).toHaveBeenCalledOnce()
    }
    const throttled = respond(429)
    expect(
      await resumableSse({
        connect: throttled,
        onEvent: vi.fn(),
        onTruncated: vi.fn(),
        backoff: { sleep, maxAttempts: 3 },
      }),
    ).toMatchObject({ ended: 'gave_up' })
    expect(throttled).toHaveBeenCalledTimes(3)
  })

  test('does not reconnect after a close comment', async () => {
    const connect = vi.fn(() => fromText(wireEvent('0') + ': stream closed\n', { open: true }))
    expect(await resumableSse({ connect, onEvent: vi.fn(), onTruncated: vi.fn() })).toEqual({
      ended: 'server_closed',
      lastEventId: '0',
    })
    expect(connect).toHaveBeenCalledOnce()
  })

  test('surfaces truncation with the connection resume ID even when the control frame inherits an ID', async () => {
    const onEvent = vi.fn()
    const onTruncated = vi.fn()
    const connect = vi.fn(() =>
      fromText(
        wireEvent('5') +
          'data: {"event":"replay.truncated","oldest_retained_seq":5}\n\n' +
          wireEvent('6') +
          ': stream closed\n',
      ),
    )
    expect(await resumableSse({ connect, lastEventId: '2', onEvent, onTruncated })).toEqual({
      ended: 'server_closed',
      lastEventId: '6',
    })
    expect(onTruncated).toHaveBeenCalledExactlyOnceWith({ oldestRetainedSeq: 5, requestedSeq: '2' })
    expect(onEvent.mock.calls.map(([frame]) => frame.id)).toEqual(['5', '6'])
  })

  test.each([-1, 1.5, '5', null])(
    'rejects malformed truncation sequence %j before calling consumers',
    async (seq) => {
      const connect = vi.fn(() =>
        fromText(
          `data: ${JSON.stringify({ event: 'replay.truncated', oldest_retained_seq: seq })}\n\n`,
        ),
      )
      const onTruncated = vi.fn()
      await expect(resumableSse({ connect, onEvent: vi.fn(), onTruncated })).rejects.toThrow(
        'Invalid SSE replay truncation signal',
      )
      expect(onTruncated).not.toHaveBeenCalled()
      expect(connect).toHaveBeenCalledOnce()
    },
  )

  test('gives up after eight consecutive failures with exponential delays capped at ten seconds', async () => {
    vi.useFakeTimers()
    const connect = vi.fn(() => {
      throw new Error('offline')
    })
    const onEvent = vi.fn()
    const promise = resumableSse({
      connect,
      lastEventId: '12',
      onEvent,
      onTruncated: vi.fn(),
      backoff: { random: () => 0.5 },
    })
    for (const [index, ms] of [500, 1000, 2000, 4000, 8000, 10000, 10000].entries()) {
      expect(connect).toHaveBeenCalledTimes(index + 1)
      await vi.advanceTimersByTimeAsync(ms - 1)
      expect(connect).toHaveBeenCalledTimes(index + 1)
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(await promise).toEqual({ ended: 'gave_up', lastEventId: '12' })
    expect(connect).toHaveBeenCalledTimes(8)
    expect(onEvent).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('resets backoff and failure count after a successful frame', async () => {
    let calls = 0
    const connect = vi.fn(() => {
      calls++
      if (calls === 3) return fromText(wireEvent('1'), { disconnect: true })
      if (calls === 5) return fromText(': stream closed\n')
      throw new Error('offline')
    })
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {})
    expect(
      await resumableSse({
        connect,
        onEvent: vi.fn(),
        onTruncated: vi.fn(),
        backoff: { maxAttempts: 3, sleep, random: () => 0.5 },
      }),
    ).toEqual({ ended: 'server_closed', lastEventId: '1' })
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000, 500, 1000])
  })

  test.each([0, 1])('applies injectable jitter %s within the delay cap', async (random) => {
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {})
    await resumableSse({
      connect: () => {
        throw new Error('offline')
      },
      onEvent: vi.fn(),
      onTruncated: vi.fn(),
      backoff: { sleep, random: () => random, maxAttempts: 3, initialMs: 8000 },
    })
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(random === 0 ? [6400, 8000] : [9600, 10000])
  })

  test('honors upstream retry state when reconnecting', async () => {
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {})
    let calls = 0
    const connect = () => fromText(++calls === 1 ? 'retry: 1250\n\n' : ': stream closed\n')
    await resumableSse({
      connect,
      onEvent: vi.fn(),
      onTruncated: vi.fn(),
      backoff: { sleep, random: () => 0.5 },
    })
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1250, undefined)
  })

  test('honors retry-only lines received just before a network failure', async () => {
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {})
    let calls = 0
    await resumableSse({
      connect: () =>
        ++calls === 1
          ? fromText('retry: 1250\n', { disconnect: true })
          : fromText(': stream closed\n'),
      onEvent: vi.fn(),
      onTruncated: vi.fn(),
      backoff: { sleep, random: () => 0.5 },
    })
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1250, undefined)
  })

  test('compares numeric resume IDs exactly above the safe integer range', async () => {
    const onEvent = vi.fn()
    const lastEventId = '9007199254740992'
    expect(
      await resumableSse({
        connect: () =>
          fromText(wireEvent(lastEventId) + wireEvent('9007199254740993') + ': stream closed\n'),
        lastEventId,
        onEvent,
        onTruncated: vi.fn(),
      }),
    ).toEqual({ ended: 'server_closed', lastEventId: '9007199254740993' })
    expect(onEvent.mock.calls.map(([frame]) => frame.id)).toEqual(['9007199254740993'])
  })

  test('pre-abort avoids invoking the connection factory', async () => {
    const controller = new AbortController()
    controller.abort()
    const connect = vi.fn(() => fromText(''))
    expect(
      await resumableSse({
        connect,
        onEvent: vi.fn(),
        onTruncated: vi.fn(),
        signal: controller.signal,
      }),
    ).toEqual({ ended: 'aborted', lastEventId: undefined })
    expect(connect).not.toHaveBeenCalled()
  })

  test('aborting during backoff clears the timer and stops reconnecting', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const connect = vi.fn(() => {
      throw new Error('offline')
    })
    const promise = resumableSse({
      connect,
      onEvent: vi.fn(),
      onTruncated: vi.fn(),
      signal: controller.signal,
    })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect(await promise).toEqual({ ended: 'aborted', lastEventId: undefined })
    expect(connect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('wrapper abort interrupts and cancels an active connection without its own signal', async () => {
    const controller = new AbortController()
    const onEvent = vi.fn(() => controller.abort())
    const connect = vi.fn(() => fromText(wireEvent('0'), { open: true }))
    expect(
      await resumableSse({ connect, onEvent, onTruncated: vi.fn(), signal: controller.signal }),
    ).toEqual({ ended: 'aborted', lastEventId: '0' })
    expect(connect).toHaveBeenCalledOnce()
  })

  test('wrapper abort interrupts a pending read and a pending connection factory', async () => {
    for (const connect of [
      () => fromText('', { open: true }),
      () => new Promise<SseConnection>(() => {}),
    ]) {
      const controller = new AbortController()
      const promise = resumableSse({
        connect,
        onEvent: vi.fn(),
        onTruncated: vi.fn(),
        signal: controller.signal,
      })
      await Promise.resolve()
      await Promise.resolve()
      controller.abort()
      expect(await promise).toEqual({ ended: 'aborted', lastEventId: undefined })
    }
  })

  test('an aborted connection does not reconnect', async () => {
    const connect = vi.fn(() => {
      const connection = fromText('')
      connection.abort()
      return connection
    })
    expect(await resumableSse({ connect, onEvent: vi.fn(), onTruncated: vi.fn() })).toEqual({
      ended: 'aborted',
      lastEventId: undefined,
    })
    expect(connect).toHaveBeenCalledOnce()
  })

  test('consumer errors propagate without reconnecting or acknowledging their event', async () => {
    const connect = vi.fn(() => fromText(wireEvent('1'), { open: true }))
    const failure = new Error('consumer failed')
    await expect(
      resumableSse({
        connect,
        onEvent: () => {
          throw failure
        },
        onTruncated: vi.fn(),
      }),
    ).rejects.toBe(failure)
    expect(connect).toHaveBeenCalledOnce()
  })

  test('a rejected truncation callback propagates without reconnecting', async () => {
    const connect = vi.fn(() =>
      fromText('data: {"event":"replay.truncated","oldest_retained_seq":5}\n\n', { open: true }),
    )
    const failure = new Error('gap recorder failed')
    const onTruncated = vi.fn(async () => {
      throw failure
    })
    await expect(resumableSse({ connect, onEvent: vi.fn(), onTruncated })).rejects.toBe(failure)
    expect(onTruncated).toHaveBeenCalledExactlyOnceWith({
      oldestRetainedSeq: 5,
      requestedSeq: undefined,
    })
    expect(connect).toHaveBeenCalledOnce()
  })

  test('resumes against a local HTTP server after a mid-stream socket disconnect', async (context) => {
    const cursors: (string | undefined)[] = []
    let first: ServerResponse | undefined
    const server = createServer((request, reply) => {
      const cursor = request.headers['last-event-id'] as string | undefined
      cursors.push(cursor)
      reply.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (cursor === undefined) {
        first = reply
        reply.write(wireEvent('1'))
      } else reply.end(wireEvent('1') + wireEvent('2') + ': stream closed\n')
    })
    try {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', resolve)
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM')
          context.skip('Sandbox forbids listening; fake-fetch resume tests cover this path')
        throw error
      }
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing test server address')
      const onEvent = vi.fn((frame: SseFrame) => {
        if (frame.type === 'event' && frame.id === '1') first?.destroy()
      })
      const result = await resumableSse({
        connect: (lastEventId) =>
          connectSse({
            url: `http://127.0.0.1:${address.port}/p/builder/v1/runs/example/events`,
            lastEventId,
          }),
        onEvent,
        onTruncated: vi.fn(),
        backoff: { sleep: async () => {} },
      })
      expect(result).toEqual({ ended: 'server_closed', lastEventId: '2' })
      expect(cursors).toEqual([undefined, '1'])
      expect(onEvent.mock.calls.map(([frame]) => frame.type === 'event' && frame.id)).toEqual([
        '1',
        '2',
      ])
    } finally {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
