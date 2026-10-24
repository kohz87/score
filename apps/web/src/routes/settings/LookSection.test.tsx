import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { LookSection } from './LookSection.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('Display currency saves the typed code and rate', async () => {
  const fetch = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      Response.json(
        init?.method === 'PUT' ? JSON.parse(String(init.body)) : { code: 'USD', rate: 1 },
      ),
    ),
  )
  vi.stubGlobal('fetch', fetch)
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <LookSection />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const save = screen.getByRole('button', { name: 'Save' })
  fireEvent.change(await screen.findByLabelText('Currency code'), { target: { value: 'eur' } })
  fireEvent.change(screen.getByLabelText('Rate (1 USD =)'), { target: { value: '0.92' } })
  fireEvent.click(save)
  await screen.findByText('Saved.')
  const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!
  expect(JSON.parse(String(put[1]!.body))).toEqual({ code: 'EUR', rate: 0.92 })
  fireEvent.change(screen.getByLabelText('Rate (1 USD =)'), { target: { value: '0' } })
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true),
  )
})

test('"Send messages with" is a per-device choice between Enter and Ctrl+Enter', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json({ code: 'USD', rate: 1 }))),
  )
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <LookSection />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const ctrl = screen.getByRole('radio', { name: 'Ctrl+Enter' })
  expect(screen.getByRole('radio', { name: 'Enter' }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(ctrl)
  expect(localStorage.getItem('score.sendKey')).toBe('ctrl-enter')
  expect(ctrl.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(screen.getByRole('radio', { name: 'Enter' }))
  expect(localStorage.getItem('score.sendKey')).toBeNull()
})

function mountLook(fetch: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetch)
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <LookSection />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

test('Style is always shown; picking a theme is this device’s choice and is remembered', () => {
  window.localStorage.clear()
  mountLook(vi.fn(() => Promise.resolve(Response.json({ code: 'USD', rate: 1 }))))
  const group = screen.getByRole('radiogroup', { name: 'Style' })
  expect(group.querySelectorAll('[role="radio"]')).toHaveLength(4)
  fireEvent.click(screen.getByRole('radio', { name: /Dense/ }))
  expect(window.localStorage.getItem('score.look.device')).toBe('dense')
  expect(screen.getByRole('radio', { name: /Dense/ }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByText(/This device uses Dense instead of the shared Score/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Use the shared theme' }))
  expect(window.localStorage.getItem('score.look.device')).toBeNull()
  expect(screen.getByRole('radio', { name: /^Score/ }).getAttribute('aria-checked')).toBe('true')
})

test('Theme for every device saves through PUT /api/look and lists the server’s themes', async () => {
  window.localStorage.clear()
  const themes = {
    items: ['score', 'harbour'].map((id) => ({
      id,
      name: id === 'score' ? 'Score' : 'Harbour',
      version: '1.0.0',
      author: null,
      description: null,
      source: id === 'score' ? 'builtin' : 'imported',
      updatedAt: '2026-10-17T00:00:00.000Z',
      hasCss: false,
    })),
    active: 'score',
    mode: 'system',
  }
  const fetch = vi.fn((url: string, init?: RequestInit) =>
    Promise.resolve(
      String(url).endsWith('/api/themes')
        ? Response.json(themes)
        : init?.method === 'PUT' && String(url).endsWith('/api/look')
          ? new Response(null, { status: 204 })
          : Response.json({ code: 'USD', rate: 1 }),
    ),
  )
  mountLook(fetch)
  await screen.findByRole('radio', { name: /Harbour/ })
  fireEvent.change(screen.getByLabelText('Theme for every device'), {
    target: { value: 'harbour' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save for every device' }))
  await waitFor(() =>
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true),
  )
  const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!
  expect(String(put[0])).toBe('/api/look')
  expect(JSON.parse(String(put[1]!.body))).toEqual({ activeTheme: 'harbour', mode: 'system' })
})

test('Reset look on this device sends this device back to Score’s own look', () => {
  window.localStorage.clear()
  window.localStorage.setItem('score.look.device', 'night')
  window.localStorage.setItem('score.look.cache', '{"id":"night"}')
  mountLook(vi.fn(() => Promise.resolve(Response.json({ code: 'USD', rate: 1 }))))
  fireEvent.click(screen.getByRole('button', { name: 'Reset look on this device' }))
  expect(window.localStorage.getItem('score.look.device')).toBe('score')
  expect(window.localStorage.getItem('score.look.cache')).toBeNull()
})

test('classic Settings offers the way back to the new look', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json({ code: 'USD', rate: 1 }))),
  )
  const router = createMemoryRouter(
    [
      { path: '/settings/look', element: <LookSection /> },
      { path: '/b', element: <p>New look</p> },
    ],
    { initialEntries: ['/settings/look'] },
  )
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Use the new look' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/b'))
  expect(window.localStorage.getItem('score.ui')).toBeNull()
})

test('the currency inputs are styled like the other Settings fields', () => {
  const css = readFileSync(join(import.meta.dirname, 'settings.css'), 'utf8')
  const rule = /\.plugins-currency input \{([^}]*)\}/.exec(css)?.[1] ?? ''
  expect(rule).toMatch(/border:\s*1px solid var\(--hairline\)/)
  expect(rule).toMatch(/border-radius:\s*var\(--radius-14\)/)
  expect(rule).toMatch(/background:\s*var\(--card\)/)
  expect(rule).toMatch(/height:\s*40px/)
  expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b/i)
})

test('"Agents" is a per-device choice between Calm and Still', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json({ code: 'USD', rate: 1 }))),
  )
  localStorage.removeItem('score.liveliness')
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <LookSection />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const group = screen.getByRole('radiogroup', { name: 'Agents' })
  expect(
    within(group)
      .getAllByRole('radio')
      .map((radio) => radio.textContent),
  ).toEqual(['Calm', 'Still'])
  expect(within(group).getByRole('radio', { name: 'Calm' }).getAttribute('aria-checked')).toBe(
    'true',
  )
  fireEvent.click(within(group).getByRole('radio', { name: 'Still' }))
  expect(screen.getByText(/nothing moves/i)).toBeDefined()
  expect(localStorage.getItem('score.liveliness')).toBe('still')
  fireEvent.click(within(group).getByRole('radio', { name: 'Calm' }))
  expect(localStorage.getItem('score.liveliness')).toBeNull()
  localStorage.removeItem('score.liveliness')
})
