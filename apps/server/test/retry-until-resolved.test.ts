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
