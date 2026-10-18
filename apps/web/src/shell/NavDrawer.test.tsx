import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DEFAULT_LAYOUT, resolveLayout, setLayout } from '../themes/layout.ts'
import { NavDrawer } from './NavDrawer.tsx'

// The dots need the query client; the drawer's own behaviour is under test here.
vi.mock('./MainNav.tsx', () => ({ HermesCheckDot: () => null, NeedsYouDot: () => null }))

const launcher = resolveLayout({ layout: { nav: 'launcher' } })

function desktop(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(min-width: 1024px)' ? matches : false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  )
}
const drawer = (onClose: () => void) => (
  <MemoryRouter>
    <NavDrawer open onClose={onClose} terminalOffered={false} />
  </MemoryRouter>
)

beforeEach(() => setLayout(DEFAULT_LAYOUT))
afterEach(() => {
  cleanup()
  setLayout(DEFAULT_LAYOUT)
  vi.unstubAllGlobals()
  document.body.classList.remove('scroll-locked')
})

test('the launcher drawer stays open on a desktop window', () => {
  desktop(true)
  setLayout(launcher)
  const onClose = vi.fn()
  render(drawer(onClose))
  expect(screen.getByRole('dialog', { name: 'Menu' })).toBeTruthy()
  expect(onClose).not.toHaveBeenCalled()
})

test('an open drawer closes when the launcher goes away on a desktop window (a reset, a live theme change)', () => {
  desktop(true)
  setLayout(launcher)
  const onClose = vi.fn()
  render(drawer(onClose))
  expect(onClose).not.toHaveBeenCalled()
  act(() => setLayout(resolveLayout({ layout: { nav: 'top' } })))
  expect(onClose).toHaveBeenCalled()
})

test('an open drawer closes at once when it is opened where it is not shown', () => {
  desktop(true)
  const onClose = vi.fn()
  render(drawer(onClose))
  expect(onClose).toHaveBeenCalled()
})

test('on a phone the drawer stays open whatever the layout does', () => {
  desktop(false)
  setLayout(launcher)
  const onClose = vi.fn()
  render(drawer(onClose))
  act(() => setLayout(DEFAULT_LAYOUT))
  expect(onClose).not.toHaveBeenCalled()
})
