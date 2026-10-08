import { afterEach, expect, test, vi } from 'vitest'
import { throttle } from './throttle.ts'

afterEach(() => vi.useRealTimers())

test('throttle runs the first call at once and collapses a burst into one trailing run', () => {
  vi.useFakeTimers()
  const run = vi.fn()
  const throttled = throttle(run, 100)
  throttled()
  throttled()
  throttled()
  expect(run).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(100)
  expect(run).toHaveBeenCalledTimes(2)
  vi.advanceTimersByTime(1000)
  expect(run).toHaveBeenCalledTimes(2)
  throttled()
  expect(run).toHaveBeenCalledTimes(3)
})

test('throttle cancel drops the trailing run', () => {
  vi.useFakeTimers()
  const run = vi.fn()
  const throttled = throttle(run, 100)
  throttled()
  throttled()
  throttled.cancel()
  vi.advanceTimersByTime(1000)
  expect(run).toHaveBeenCalledTimes(1)
  throttled()
  expect(run).toHaveBeenCalledTimes(2)
})
