import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useRecentlyResolved } from './use-recently-resolved.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const outcome = (id: string) => ({
  label: id,
  chip: { tone: 'ok' as const, text: 'Approved by you', at: '2026-10-11T14:02:00.000Z' },
})

test('a card that leaves the list becomes a chip for a while, then is gone', () => {
  const { result, rerender } = renderHook(
    ({ open }: { open: string[] }) => useRecentlyResolved(new Set(open), outcome, 1000),
    { initialProps: { open: ['g1', 'g2'] } },
  )
  expect(result.current).toEqual([])
  rerender({ open: ['g2'] })
  expect(result.current.map((item) => item.id)).toEqual(['g1'])
  // Re-rendering with the same content must not restart or drop the chip.
  rerender({ open: ['g2'] })
  expect(result.current).toHaveLength(1)
  act(() => void vi.advanceTimersByTime(1001))
  expect(result.current).toEqual([])
})

test('an id that wasn’t decided leaves no chip', () => {
  const { result, rerender } = renderHook(
    ({ open }: { open: string[] }) => useRecentlyResolved(new Set(open), () => null, 1000),
    { initialProps: { open: ['g1'] } },
  )
  rerender({ open: [] })
  expect(result.current).toEqual([])
})
