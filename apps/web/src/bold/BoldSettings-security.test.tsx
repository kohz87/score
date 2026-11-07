import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { open, settingsState } from './BoldSettings-helpers.tsx'

test('Remote access and security keeps the protected password, browsers and passkey surfaces', async () => {
  open('/b/settings/security')
  expect(await screen.findByRole('heading', { name: 'Remote access and security' })).toBeDefined()
  expect(screen.getByRole('heading', { name: 'Where agents run' })).toBeDefined()
  const where = await screen.findByRole('list', { name: 'Where agents run' })
  expect(where.textContent).toContain('builder')
  expect(where.textContent).toContain('Docker · node:24')
  expect(where.textContent).toContain('Partly separated')
  expect(within(where).getByRole('link', { name: 'Runs on' }).getAttribute('href')).toBe(
    '/b/agents/builder#agent-where',
  )
  const grid = document.querySelector('.bold-security-open')!
  expect(grid.getAttribute('data-protected')).toBe('grid')
  expect(await screen.findByRole('list', { name: 'Paired browsers' })).toHaveProperty(
    'textContent',
    expect.stringContaining('Laptop'),
  )
  expect(screen.getByRole('button', { name: 'Log out this browser' })).toBeDefined()
  expect(await screen.findByRole('heading', { name: 'Passkeys' })).toBeDefined()
  expect(screen.getByRole('link', { name: 'Open the terminal' }).getAttribute('href')).toBe(
    '/terminal',
  )
})

test('Remote access and security lists open terminals and closes one', async () => {
  settingsState.terminalOn = true
  try {
    open('/b/settings/security')
    const list = await screen.findByRole('list', { name: 'Open terminals' })
    expect(await within(list).findByText(/from 10\.0\.0\.5/)).toBeDefined()
    fireEvent.click(within(list).getByRole('button', { name: 'Close' }))
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(
            ([url, init]) =>
              String(url) === '/api/terminal/sessions/3f1c6a52-1b7e-4c1c-9a53-0d5c1a2b3c4d' &&
              (init as RequestInit | undefined)?.method === 'DELETE',
          ),
      ).toBe(true),
    )
  } finally {
    settingsState.terminalOn = false
  }
})
