import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  requestDelete,
  resetMessageDeletion,
  UNDO_MS,
  undoDelete,
  usePendingDeletes,
} from './message-deletion.ts'

// Audit wave 4 (batch B): Undo must end when the DELETE is sent, not when it finishes.
let finish: (() => void) | null
beforeEach(() => {
  vi.useFakeTimers()
  finish = null
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = () => resolve(new Response(null, { status: 204 }))
        }),
    ),
  )
})
afterEach(() => {
  resetMessageDeletion()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('Undo is gone once the DELETE is sent, and calling it then changes nothing', async () => {
  const seen: { ids: string[]; hidden: string[] }[] = []
  const hook = renderHook(() => usePendingDeletes())
  const read = () =>
    seen.push({ ids: [...hook.result.current.ids], hidden: [...hook.result.current.hidden] })
  act(() => requestDelete('general', 'm1'))
  read()
  expect(seen[0]).toEqual({ ids: ['m1'], hidden: ['m1'] })
  await act(() => vi.advanceTimersByTimeAsync(UNDO_MS))
  expect(fetch).toHaveBeenCalledTimes(1)
  read()
  expect(seen[1]).toEqual({ ids: [], hidden: ['m1'] })
  act(() => undoDelete('m1'))
  read()
  expect(seen[2]!.hidden).toEqual(['m1'])
  finish?.()
  await act(() => vi.advanceTimersByTimeAsync(0))
  read()
  expect(seen[3]!.hidden).toEqual(['m1'])
})
