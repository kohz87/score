import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { TerminalButton } from './TerminalButton.tsx'

const status = (terminal: boolean, terminalUnavailable: string | null = null) =>
  new Response(JSON.stringify({ passwordSet: true, terminal, terminalUnavailable }), {
    status: 200,
  })
function mount() {
  render(
    <MemoryRouter>
      <TerminalButton />
    </MemoryRouter>,
  )
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('links to the terminal when the server offers one', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => status(true)),
  )
  mount()
  expect((await screen.findByRole('link', { name: 'Terminal' })).getAttribute('href')).toBe(
    '/terminal',
  )
})

test('is absent when the terminal is off or unavailable', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => status(true, 'node-pty not built')),
  )
  mount()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(screen.queryByRole('link', { name: 'Terminal' })).toBeNull()
})
