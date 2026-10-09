import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { UpdateBanner } from './UpdateBanner.tsx'
import { setWaitingWorker } from './service-worker.ts'

afterEach(() => {
  cleanup()
  act(() => setWaitingWorker(undefined))
  vi.unstubAllGlobals()
})

test('a waiting worker shows "Update available · Reload", and Reload asks it to take over', () => {
  const postMessage = vi.fn()
  vi.stubGlobal('navigator', { ...navigator, serviceWorker: { addEventListener: vi.fn() } })
  render(<UpdateBanner />)
  expect(screen.queryByText('Update available')).toBeNull()
  act(() => setWaitingWorker({ postMessage } as unknown as ServiceWorker))
  expect(screen.getByText('Update available')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
  expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
})
