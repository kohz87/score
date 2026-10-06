import type { StreamEvent } from '@score/contract'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { afterEach, expect, test, vi } from 'vitest'
import { createFanout, eventFrame } from '../../src/hub/fanout.ts'
import type { CommittedListener, Ingest } from '../../src/hub/ingest.ts'

class TestResponse extends EventEmitter {
  frames: string[] = []
  writableLength = 0
  destroyed = false
  backpressure = false

  write(frame: string) {
    this.frames.push(frame)
    if (this.backpressure) this.writableLength += Buffer.byteLength(frame)
    return !this.backpressure
  }

  drain() {
    this.writableLength = 0
    this.backpressure = false
    this.emit('drain')
  }

  end() {}

  destroy() {
    this.destroyed = true
    this.emit('close')
  }

  get raw() {
    // Exercise write/drain deterministically without depending on OS socket buffer sizes.
    return this as unknown as ServerResponse
  }
}

function event(seq: number): StreamEvent {
  return {
    seq,
    ts: '2026-10-06T12:00:00.000Z',
    type: 'message.completed',
    data: { roomId: 'room', messageId: String(seq) },
  }
}

function setup(options: Parameters<typeof createFanout>[1] = {}) {
  let deliver: CommittedListener = () => {}
  const unsubscribe = vi.fn()
  const ingest = {
    onCommitted: vi.fn((listener: CommittedListener) => {
      deliver = listener
      return unsubscribe
    }),
  }
  const fanout = createFanout(ingest as unknown as Ingest, options)
  return { fanout, ingest, unsubscribe, deliver: (seq: number) => deliver([event(seq)]) }
}

afterEach(() => vi.useRealTimers())

test('one ingest registration fans out, buffers until release, and drops delayed batches below the head', () => {
  const { fanout, ingest, deliver, unsubscribe } = setup()
  const first = new TestResponse()
  const second = new TestResponse()
  const subscriber = fanout.subscribe(first.raw)
  fanout.subscribe(second.raw).release(0)
  deliver(1)
  deliver(2)
  expect(first.frames).toEqual([])
  subscriber.write('hello\n\n')
  subscriber.write(eventFrame(event(1)))
  subscriber.release(1)
  deliver(1)
  deliver(2)
  deliver(3)
  expect(first.frames).toEqual(['hello\n\n', ...[1, 2, 3].map((seq) => eventFrame(event(seq)))])
  expect(second.frames).toEqual([1, 2, 3].map((seq) => eventFrame(event(seq))))
  expect(ingest.onCommitted).toHaveBeenCalledOnce()
  fanout.close()
  fanout.close()
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(first.destroyed).toBe(true)
  expect(second.destroyed).toBe(true)
})

test('queued writes preserve order after drain and waiters resume', async () => {
  const { fanout } = setup()
  const raw = new TestResponse()
  raw.backpressure = true
  const subscriber = fanout.subscribe(raw.raw)
  subscriber.write('one')
  subscriber.write('two')
  let resumed = false
  const ready = subscriber.writable().then(() => (resumed = true))
  await Promise.resolve()
  expect(resumed).toBe(false)
  expect(raw.frames).toEqual(['one'])
  raw.drain()
  await ready
  expect(resumed).toBe(true)
  expect(raw.frames).toEqual(['one', 'two'])
  fanout.close()
})

test('budget counts UTF-8 bytes of the pre-fence buffer and of frames held back while blocked', () => {
  const { fanout, deliver } = setup({ byteBudget: 300 })
  const buffered = new TestResponse()
  fanout.subscribe(buffered.raw)
  deliver(1)
  deliver(2)
  deliver(3)
  expect(buffered.destroyed).toBe(true)
  const slow = new TestResponse()
  slow.backpressure = true
  const subscriber = fanout.subscribe(slow.raw)
  // The first frame is handed to the socket (which then reports backpressure); it is not counted.
  subscriber.write('é'.repeat(100))
  subscriber.write('é'.repeat(100)) // held back: 200 bytes
  expect(slow.destroyed).toBe(false)
  subscriber.write('é'.repeat(51)) // held back: 302 bytes > 300
  expect(slow.destroyed).toBe(true)
  fanout.close()
})

test('write timeout destroys only the blocked client and wakes replay waiters', async () => {
  vi.useFakeTimers()
  const { fanout, deliver } = setup({ writeTimeoutMs: 20 })
  const slow = new TestResponse()
  slow.backpressure = true
  const fast = new TestResponse()
  const blocked = fanout.subscribe(slow.raw)
  blocked.release(0)
  fanout.subscribe(fast.raw).release(0)
  deliver(1)
  const ready = blocked.writable()
  await vi.advanceTimersByTimeAsync(20)
  await ready
  expect(slow.destroyed).toBe(true)
  deliver(2)
  expect(fast.destroyed).toBe(false)
  expect(fast.frames).toEqual([1, 2].map((seq) => eventFrame(event(seq))))
  expect(slow.listenerCount('drain')).toBe(0)
  expect(slow.listenerCount('error')).toBe(0)
  fanout.close()
})

test('drain cancels the write timeout and close removes the subscriber', async () => {
  vi.useFakeTimers()
  const { fanout, deliver } = setup({ writeTimeoutMs: 20 })
  const raw = new TestResponse()
  raw.backpressure = true
  const subscriber = fanout.subscribe(raw.raw)
  subscriber.release(0)
  deliver(1)
  raw.drain()
  await vi.advanceTimersByTimeAsync(30)
  expect(raw.destroyed).toBe(false)
  raw.destroy()
  deliver(2)
  expect(raw.frames).toEqual([eventFrame(event(1))])
  expect(raw.listenerCount('drain')).toBe(0)
  fanout.close()
  expect(vi.getTimerCount()).toBe(0)
})

test('write exceptions and socket errors disconnect only that subscriber', () => {
  const { fanout, deliver } = setup()
  const broken = new TestResponse()
  const fast = new TestResponse()
  vi.spyOn(broken, 'write').mockImplementation(() => {
    throw new Error('socket failed')
  })
  fanout.subscribe(broken.raw).release(0)
  fanout.subscribe(fast.raw).release(0)
  deliver(1)
  expect(broken.destroyed).toBe(true)
  expect(fast.frames).toEqual([eventFrame(event(1))])
  fast.emit('error', new Error('socket failed'))
  expect(fast.destroyed).toBe(true)
  fanout.close()
})
