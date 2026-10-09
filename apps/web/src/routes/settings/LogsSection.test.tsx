import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { LogsSection, logLine } from './LogsSection.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const entry = {
  time: '2026-10-09T10:00:00.000Z',
  level: 'warn' as const,
  message: 'slow request',
  method: 'GET',
  url: '/api/agents',
  status: 200,
  durationMs: 1234.6,
}
function mount(fetch: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetch)
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LogsSection />
    </QueryClientProvider>,
  )
}

test('shows parsed lines and sends the level and keyword filters to the server', async () => {
  const fetch = vi.fn(() => Promise.resolve(Response.json({ available: true, items: [entry] })))
  mount(fetch)
  await screen.findByText('slow request')
  expect(screen.getByText('GET /api/agents 200 1235 ms')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Level'), { target: { value: 'warn' } })
  fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'slow' } })
  await waitFor(() => {
    const urls = fetch.mock.calls.map(([url]) => String(url))
    expect(urls.some((url) => url.includes('level=warn') && url.includes('q=slow'))).toBe(true)
  })
})

test('says so when the server has no log file, and the line format is stable for downloads', async () => {
  mount(vi.fn(() => Promise.resolve(Response.json({ available: false, items: [] }))))
  await screen.findByText(/not started with a log file/)
  expect(logLine(entry)).toBe(
    '2026-10-09T10:00:00.000Z WARN slow request GET /api/agents -> 200 (1235 ms)',
  )
})
