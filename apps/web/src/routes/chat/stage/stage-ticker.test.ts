import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { subscribeFrame } from './stage-ticker.ts'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})

test('twelve subscribers share one animation-frame loop, and it stops with the last one', () => {
  const raf = vi.spyOn(globalThis, 'requestAnimationFrame')
  const calls = Array.from({ length: 12 }, () => vi.fn())
  const stops = calls.map((call) => subscribeFrame(call))
  expect(raf).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(100)
  for (const call of calls) expect(call.mock.calls.length).toBeGreaterThan(3)
  // One request per frame, not one per subscriber.
  expect(raf.mock.calls.length).toBeLessThanOrEqual(calls[0]!.mock.calls.length + 2)
  for (const stop of stops) stop()
  const before = raf.mock.calls.length
  vi.advanceTimersByTime(100)
  expect(raf.mock.calls.length).toBeLessThanOrEqual(before + 1)
  const quiet = raf.mock.calls.length
  vi.advanceTimersByTime(100)
  expect(raf.mock.calls.length).toBe(quiet)
})

test('a frame carries the seconds since the last, capped, so a long pause is not a jump', () => {
  const seen: number[] = []
  const stop = subscribeFrame((_now, seconds) => seen.push(seconds))
  vi.advanceTimersByTime(64)
  stop()
  expect(seen.every((seconds) => seconds > 0 && seconds <= 0.1)).toBe(true)
})

test('nothing runs while the tab is hidden', () => {
  const call = vi.fn()
  const stop = subscribeFrame(call)
  vi.advanceTimersByTime(50)
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
  document.dispatchEvent(new Event('visibilitychange'))
  call.mockClear()
  vi.advanceTimersByTime(500)
  expect(call).not.toHaveBeenCalled()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  document.dispatchEvent(new Event('visibilitychange'))
  vi.advanceTimersByTime(50)
  expect(call).toHaveBeenCalled()
  stop()
})
