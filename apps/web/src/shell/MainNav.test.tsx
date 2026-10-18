import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DEFAULT_LAYOUT, resolveLayout, setLayout } from '../themes/layout.ts'
import { MainNav } from './MainNav.tsx'

// The dots need the query client; the navigation's own labels are under test here.
vi.mock('../routes/settings/settings-queries.ts', () => ({
  needsHermesCheck: () => false,
  useSystemStatus: () => ({ data: undefined }),
}))
vi.mock('./use-needs-you.ts', () => ({ useNeedsYou: () => false }))

const nav = () => (
  <MemoryRouter initialEntries={['/now']}>
    <MainNav />
  </MemoryRouter>
)

beforeEach(() => setLayout(DEFAULT_LAYOUT))
afterEach(() => {
  cleanup()
  setLayout(DEFAULT_LAYOUT)
})

// Third gate, finding 5: whatever the manifest says, Settings is a destination with a name and a visible label.
test.each([' ', '​', ' ⁠﻿ ', 'ㅤ'])(
  'a Settings label of %j (as an old cached look might hold it) still shows “Settings”',
  (label) => {
    setLayout(
      resolveLayout({ layout: { menu: [{ to: '/now' }, { to: '/settings', label }] } as never }),
    )
    render(nav())
    const link = screen.getByRole('link', { name: 'Settings' })
    expect(link.textContent?.trim()).toBe('Settings')
  },
)

test('a renamed Settings keeps “Settings” in its accessible name and its own label visible', () => {
  setLayout(resolveLayout({ layout: { menu: [{ to: '/settings', label: 'Setup' }] } }))
  render(nav())
  const link = screen.getByRole('link', { name: /Settings/ })
  expect(link.textContent?.trim()).toBe('Setup')
  expect(link.getAttribute('aria-label')).toBe('Settings (Setup)')
})

test('the default Settings link needs no extra label', () => {
  render(nav())
  expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-label')).toBeNull()
})
