import {
  parseStreamFrame,
  StreamEventSchema,
  StreamEnvelopeSchema,
  type StreamControlFrame,
  type StreamEvent,
} from '@score/contract'

export type StreamStatus = 'connecting' | 'open' | 'reconnecting'
export type StreamControl = { frame: StreamControlFrame; resync: boolean; epochChanged: boolean }
export type StreamSource = {
  subscribe: (listener: (event: StreamEvent) => void) => () => void
  onControl: (listener: (control: StreamControl) => void) => () => void
}

type EventSourceLike = {
  addEventListener: (type: string, listener: EventListener) => void
  close: () => void
}
type StreamClientOptions = {
  url?: string
  EventSourceImpl?: new (url: string) => EventSourceLike
  random?: () => number
  setTimeout?: (callback: () => void, delay: number) => unknown
  clearTimeout?: (timer: unknown) => void
}

export function createStreamClient({
  url = '/api/stream',
  EventSourceImpl = globalThis.EventSource,
  random = Math.random,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: cancel = (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
}: StreamClientOptions = {}) {
  const listeners = new Set<(event: StreamEvent) => void>()
  const controls = new Set<(control: StreamControl) => void>()
  const statusListeners = new Set<() => void>()
  const unknownTypes = new Set<string>()
  let currentStatus: StreamStatus = 'connecting'
  let epoch: string | undefined
  let lastSeq: number | undefined
  let backoff = 500
  let source: EventSourceLike | undefined
  let timer: unknown
  let closed = false

  function setStatus(value: StreamStatus) {
    currentStatus = value
    statusListeners.forEach((listener) => listener())
  }

  function open() {
    let nextUrl = url
    if (epoch !== undefined && lastSeq !== undefined) {
      const [path, query = ''] = url.split('?')
      const params = new URLSearchParams(query)
      params.set('since', String(lastSeq))
      params.set('epoch', epoch)
      nextUrl = `${path}?${params}`
    }
    const connection = new EventSourceImpl(nextUrl)
    source = connection
    const receive: EventListener = (message) => {
      if (closed || source !== connection) return
      const frame = message as MessageEvent<string>
      let parsed: ReturnType<typeof parseStreamFrame>
      try {
        parsed = parseStreamFrame(frame.data)
        if (parsed.kind === 'event' && frame.lastEventId !== String(parsed.event.seq))
          throw new Error('Durable stream id does not match its sequence')
      } catch (error) {
        console.error('Invalid stream frame', error)
        return
      }
      if (parsed.kind === 'unknown') {
        const envelope = StreamEnvelopeSchema.safeParse(JSON.parse(frame.data) as unknown)
        if (envelope.success && frame.lastEventId === String(envelope.data.seq))
          lastSeq = Math.max(lastSeq ?? 0, envelope.data.seq)
        if (!unknownTypes.has(parsed.type)) {
          unknownTypes.add(parsed.type)
          console.debug('Unknown stream event type', parsed.type)
        }
      } else if (parsed.kind === 'event') {
        lastSeq = Math.max(lastSeq ?? 0, Number(frame.lastEventId))
        listeners.forEach((listener) => listener(parsed.event))
      } else {
        const control = parsed.frame
        const epochChanged =
          control.type === 'stream.hello' && epoch !== undefined && epoch !== control.data.epoch
        if (control.type === 'stream.hello') {
          if (epochChanged) lastSeq = undefined
          epoch = control.data.epoch
          backoff = 500
          setStatus('open')
        }
        controls.forEach((listener) =>
          listener({
            frame: control,
            resync: epochChanged || control.type === 'stream.reset',
            epochChanged,
          }),
        )
      }
    }
    const types = [
      'message',
      'stream.hello',
      'stream.reset',
      ...StreamEventSchema.options.map((schema) => schema.shape.type.value),
    ]
    types.forEach((type) => connection.addEventListener(type, receive))
    connection.addEventListener('error', () => {
      if (closed || source !== connection) return
      connection.close()
      source = undefined
      setStatus('reconnecting')
      const delay = backoff * (0.8 + random() * 0.4)
      backoff = Math.min(backoff * 2, 10000)
      timer = schedule(open, delay)
    })
  }

  open()
  return {
    subscribe(listener: (event: StreamEvent) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onControl(listener: (control: StreamControl) => void) {
      controls.add(listener)
      return () => {
        controls.delete(listener)
      }
    },
    status: {
      getSnapshot: () => currentStatus,
      subscribe(listener: () => void) {
        statusListeners.add(listener)
        return () => {
          statusListeners.delete(listener)
        }
      },
    },
    close() {
      closed = true
      source?.close()
      if (timer !== undefined) cancel(timer)
      listeners.clear()
      controls.clear()
      statusListeners.clear()
    },
  }
}
export type StreamClient = ReturnType<typeof createStreamClient>
