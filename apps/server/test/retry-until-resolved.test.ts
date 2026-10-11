import { expect, test, vi } from 'vitest'
import { retryUntilResolved } from '../src/retry-until-resolved.ts'

test('keeps retrying at the last delay past the fast phase until nothing is unresolved', async () => {
  vi.useFakeTimers()
  try {
    let left = 5
    const work = vi.fn(async () => --left)
    const retry = retryUntilResolved(work, [10, 100])
    await vi.advanceTimersByTimeAsync(0)
    expect(work).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(100)
    expect(work).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(100)
    expect(work).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(1000)
    expect(work).toHaveBeenCalledTimes(5)
    retry.stop()
  } finally {
    vi.useRealTimers()
  }
})

test('stop() resolves only after an attempt already running has settled, and admits no further one', async () => {
  let finish!: (unresolved: number) => void
  const work = vi.fn(() => new Promise<number>((resolve) => (finish = resolve)))
  const tracked: Promise<unknown>[] = []
  const retry = retryUntilResolved(work, [5], { track: (attempt) => tracked.push(attempt) })
  expect(tracked).toHaveLength(1)
  let stopped = false
  const stopping = retry.stop().then(() => (stopped = true))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(stopped).toBe(false)
  finish(3) // would normally schedule another attempt
  await stopping
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(work).toHaveBeenCalledTimes(1)
})
