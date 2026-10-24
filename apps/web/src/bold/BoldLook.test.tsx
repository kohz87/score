import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { resetForgottenTheme } from '../data/theme.ts'
import { BoldLook } from './BoldLook.tsx'

const themes = {
  items: [
    {
      id: 'score',
      name: 'Score',
      version: '1.0.0',
      author: null,
      description: null,
      source: 'builtin',
      updatedAt: '2026-10-17T00:00:00.000Z',
      hasCss: false,
    },
    {
      id: 'harbour',
      name: 'Harbour',
      version: '1.0.0',
      author: null,
      description: null,
      source: 'imported',
      updatedAt: '2026-10-17T00:00:00.000Z',
      hasCss: true,
    },
  ],
  active: 'score',
  mode: 'dark' as 'light' | 'dark' | 'system',
  resetGeneration: 0,
}

let calls: { url: string; method: string; body: unknown }[]
let look = structuredClone(themes)

beforeEach(() => {
  window.localStorage.clear()
  resetForgottenTheme()
  look = structuredClone(themes)
  calls = []
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x')
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url: url.pathname, method, body })
      if (url.pathname === '/api/themes') return Response.json(look)
      if (url.pathname === '/api/look' && method === 'PUT') {
        look = { ...look, active: body.activeTheme, mode: body.mode }
        return new Response(null, { status: 204 })
      }
      if (url.pathname === '/api/settings/currency') return Response.json({ code: 'USD', rate: 1 })
      return Response.json({ error: { code: 'not_found', message: 'No' } }, { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mount() {
  const router = createMemoryRouter(
    [
      { path: '/b/settings/look', element: <BoldLook /> },
      { path: '/settings/look', element: <p>Classic Look</p> },
    ],
    { initialEntries: ['/b/settings/look'] },
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

test('colour, motion, text size and send key are this device’s choices and persist', async () => {
  mount()
  expect(await screen.findByRole('heading', { name: 'Look' })).toBeDefined()
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: /^Dark/ }).getAttribute('aria-checked')).toBe('true'),
  )
  fireEvent.click(screen.getByRole('radio', { name: /^Light/ }))
  expect(window.localStorage.getItem('score.theme')).toBe('light')
  expect(screen.getByRole('radio', { name: /^Light/ }).getAttribute('aria-checked')).toBe('true')

  fireEvent.click(screen.getByRole('radio', { name: 'Still' }))
  expect(window.localStorage.getItem('score.liveliness')).toBe('still')

  fireEvent.change(screen.getByRole('slider', { name: 'Text size' }), {
    target: { value: '1.15' },
  })
  expect(window.localStorage.getItem('score.textScale')).toBe('1.15')
  expect(screen.getByText('115%')).toBeDefined()

  fireEvent.click(screen.getByRole('radio', { name: 'Ctrl+Enter' }))
  expect(window.localStorage.getItem('score.sendKey')).toBe('ctrl-enter')
  expect(screen.getByRole('radio', { name: 'Ctrl+Enter' }).getAttribute('aria-checked')).toBe(
    'true',
  )
})

test('this device can follow the shared colours again, and a shared look saves through PUT /api/look', async () => {
  mount()
  await screen.findByRole('heading', { name: 'Look' })
  fireEvent.click(screen.getByRole('radio', { name: /^Light/ }))
  expect(window.localStorage.getItem('score.theme')).toBe('light')
  fireEvent.click(screen.getByRole('button', { name: 'Follow the shared colours' }))
  expect(window.localStorage.getItem('score.theme')).toBeNull()

  fireEvent.change(screen.getByLabelText('Theme for every device'), {
    target: { value: 'harbour' },
  })
  fireEvent.change(screen.getByLabelText('Colours for every device'), {
    target: { value: 'light' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save for every device' }))
  await waitFor(() =>
    expect(calls.some((call) => call.url === '/api/look' && call.method === 'PUT')).toBe(true),
  )
  const put = calls.find((call) => call.url === '/api/look' && call.method === 'PUT')!
  expect(put.body).toEqual({ activeTheme: 'harbour', mode: 'light' })
})

test('the New look switch turns this device back to classic Score', async () => {
  const router = mount()
  await screen.findByRole('heading', { name: 'Look' })
  fireEvent.click(screen.getByRole('switch', { name: 'Use the new look on this device' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/settings/look'))
  expect(window.localStorage.getItem('score.ui')).toBe('classic')
  expect(await screen.findByText('Classic Look')).toBeDefined()
})
