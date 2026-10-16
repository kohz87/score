import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AvatarMenu } from '../../shell/AvatarMenu.tsx'
import { readView, saveGuard, saveView } from './user-view.ts'

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>
}
function mount(view: 'admin' | 'user', path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AvatarMenu view={view} />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Your account' }))

beforeEach(() => window.localStorage.clear())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('admin to user: the menu switches, remembers the choice and keeps the room', () => {
  mount('admin', '/chat/r1')
  open()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to user view' }))
  expect(screen.getByTestId('where').textContent).toBe('/u/rooms/r1')
  expect(readView()).toBe('user')
})

test('user to admin without the guard opens the admin view at once', () => {
  saveView('user')
  mount('user', '/u/rooms/r1')
  open()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to admin view' }))
  expect(screen.getByTestId('where').textContent).toBe('/now')
  expect(readView()).toBe('admin')
})

test('with the guard on, the admin view opens only after the password is accepted', async () => {
  saveView('user')
  saveGuard(true)
  const answers = [
    Response.json({ error: { code: 'wrong_password', message: 'no' } }, { status: 403 }),
    new Response(null, { status: 204 }),
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(answers.shift()!)),
  )
  mount('user', '/u')
  open()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to admin view' }))
  expect(readView()).toBe('user')
  fireEvent.change(screen.getByLabelText('Security password'), { target: { value: 'nope nope' } })
  fireEvent.click(screen.getByRole('button', { name: 'Open admin view' }))
  expect((await screen.findByRole('alert')).textContent).toBe('That is not the security password.')
  expect(readView()).toBe('user')
  fireEvent.click(screen.getByRole('button', { name: 'Open admin view' }))
  await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/now'))
  expect(readView()).toBe('admin')
})
