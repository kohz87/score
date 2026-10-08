import type { ServerResponse } from 'node:http'
import type { StreamEvent } from '@score/contract'
import type { DeepReadonly, Ingest } from './ingest.ts'

export interface FanoutOptions {
  /** Backlog a subscriber may hold while its socket is blocked. */
  byteBudget?: number
  /** Largest single frame sent as is. A bigger one is replaced by a reset so clients refetch snapshots. */
  maxFrameBytes?: number
  writeTimeoutMs?: number
}

export const MAX_FRAME_BYTES = 8 * 1024 * 1024
// "pruned" is the existing "your cursor no longer leads to a complete replay" reason; the client refetches
// its snapshots and carries on from the head, which skips the oversized event.
export const OVERSIZED_RESET_FRAME = `event: stream.reset\ndata: ${JSON.stringify({ type: 'stream.reset', data: { reason: 'pruned' } })}\n\n`

export function eventFrame(event: DeepReadonly<StreamEvent>): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

export interface Subscriber {
  readonly closed: boolean
  write(frame: string): void
  writable(): Promise<void>
  release(head: number): void
  close(): void
}

export function createFanout(
  ingest: Ingest,
  {
    byteBudget = 1024 * 1024,
    maxFrameBytes = MAX_FRAME_BYTES,
    writeTimeoutMs = 10_000,
  }: FanoutOptions = {},
) {
  const subscribers = new Set<ReturnType<typeof connect>>()
  let closed = false
  const unsubscribe = ingest.onCommitted((events) => {
    for (const subscriber of subscribers) {
      for (const event of events) subscriber.deliver(event)
    }
  })

  function connect(raw: ServerResponse) {
    let stopped = false
    let buffering = true
    let lastSeq = 0
    let buffered: { seq: number; frame: string }[] = []
    let bufferedBytes = 0
    let queued: string[] = []
    let queuedBytes = 0
    let blocked = false
    let timeout: NodeJS.Timeout | undefined
    const waiters = new Set<() => void>()

    function wake(): void {
      for (const resolve of waiters) resolve()
      waiters.clear()
    }

    function cleanup(): void {
      if (stopped) return
      stopped = true
      clearTimeout(timeout)
      raw.off('drain', onDrain)
      raw.off('close', cleanup)
      raw.off('error', onError)
      buffered = []
      queued = []
      subscribers.delete(subscriber)
      wake()
    }

    function destroy(): void {
      cleanup()
      raw.destroy()
    }

    function onError(): void {
      destroy()
    }

    // Count only frames held back while the socket is blocked (plus the fence buffer). Bytes already
    // handed to the socket drain within a tick for a reading client; counting them made any burst
    // larger than the budget disconnect healthy clients. A stuck client still trips the budget or
    // the write timeout.
    function withinBudget(extra = 0): boolean {
      const held = bufferedBytes + queuedBytes
      if (held + extra <= byteBudget) return true
      // One big frame into an empty backlog is not a slow client; the write timeout still guards the socket.
      if (held === 0 && extra <= maxFrameBytes) return true
      destroy()
      return false
    }

    function flush(): void {
      while (!stopped && !blocked && queued.length > 0) {
        const frame = queued.shift()!
        queuedBytes -= Buffer.byteLength(frame)
        try {
          blocked = !raw.write(frame)
        } catch {
          destroy()
          return
        }
        if (!withinBudget()) return
        if (blocked) {
          timeout = setTimeout(destroy, writeTimeoutMs)
          timeout.unref()
        }
      }
      if (!blocked) wake()
    }

    function onDrain(): void {
      clearTimeout(timeout)
      timeout = undefined
      blocked = false
      flush()
    }

    const subscriber = {
      get closed() {
        return stopped
      },
      write(frame: string): void {
        if (stopped || !withinBudget(Buffer.byteLength(frame))) return
        queued.push(frame)
        queuedBytes += Buffer.byteLength(frame)
        flush()
      },
      writable(): Promise<void> {
        if (stopped || !blocked) return Promise.resolve()
        return new Promise((resolve) => waiters.add(resolve))
      },
      deliver(event: DeepReadonly<StreamEvent>): void {
        if (stopped || (!buffering && event.seq <= lastSeq)) return
        let frame = eventFrame(event)
        if (Buffer.byteLength(frame) > maxFrameBytes) frame = OVERSIZED_RESET_FRAME
        if (buffering) {
          const bytes = Buffer.byteLength(frame)
          if (!withinBudget(bytes)) return
          buffered.push({ seq: event.seq, frame })
          bufferedBytes += bytes
        } else {
          lastSeq = event.seq
          subscriber.write(frame)
        }
      },
      release(head: number): void {
        if (stopped) return
        lastSeq = head
        buffering = false
        const pending = buffered
        buffered = []
        for (const event of pending) {
          bufferedBytes -= Buffer.byteLength(event.frame)
          if (event.seq > lastSeq) {
            lastSeq = event.seq
            subscriber.write(event.frame)
          }
        }
      },
      close(): void {
        if (stopped) return
        cleanup()
        raw.end()
        // A non-reading socket must not keep Fastify's shutdown waiting for a flush.
        raw.destroy()
      },
    }
    raw.on('drain', onDrain)
    raw.on('close', cleanup)
    raw.on('error', onError)
    subscribers.add(subscriber)
    if (raw.destroyed || closed) subscriber.close()
    return subscriber
  }

  return {
    maxFrameBytes,
    subscribe(raw: ServerResponse): Subscriber {
      return connect(raw)
    },
    close(): void {
      if (closed) return
      closed = true
      unsubscribe()
      for (const subscriber of subscribers) subscriber.close()
    },
  }
}

export type Fanout = ReturnType<typeof createFanout>
