import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { QUIET_MS, useQuiet } from './use-quiet.ts'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

test('a room is quiet after five minutes without activity, and any activity wakes it', () => {
  expect(QUIET_MS).toBe(5 * 60_000)
  const { result, rerender } = renderHook(({ signature }) => useQuiet(signature), {
    initialProps: { signature: 'a' },
  })
  expect(result.current).toBe(false)
  act(() => {
    vi.advanceTimersByTime(QUIET_MS - 1000)
  })
  expect(result.current).toBe(false)
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(result.current).toBe(true)
  // Something happens: awake at once, and the five minutes start again.
  rerender({ signature: 'b' })
  expect(result.current).toBe(false)
  act(() => {
    vi.advanceTimersByTime(QUIET_MS - 1000)
  })
  expect(result.current).toBe(false)
  rerender({ signature: 'c' })
  act(() => {
    vi.advanceTimersByTime(QUIET_MS - 1000)
  })
  expect(result.current).toBe(false)
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(result.current).toBe(true)
})
