import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DeleteToast } from './DeleteToast.tsx'
import { requestDelete, resetMessageDeletion, UNDO_MS } from './message-deletion.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  resetMessageDeletion()
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('a message delete shows Undo, and Undo cancels the request', () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  render(<DeleteToast className="bold-job-toasts" />)
  act(() => requestDelete('room-1', 'message-1'))
  expect(screen.getByText(/Message deleted/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(screen.queryByText(/Message deleted/)).toBeNull()
  act(() => {
    vi.advanceTimersByTime(UNDO_MS + 100)
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test('a delete the server refuses is reported and can be dismissed', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 500 })),
  )
  render(<DeleteToast />)
  act(() => requestDelete('room-1', 'message-2'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(UNDO_MS + 100)
  })
  expect(screen.getByRole('alert').textContent).toContain('Couldn’t delete the message')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByRole('alert')).toBeNull()
})
