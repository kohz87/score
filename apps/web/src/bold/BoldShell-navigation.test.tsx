import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { open, shellState } from './BoldShell-helpers.tsx'

test('the phone Room badge waits for the team room and counts the job in the URL', async () => {
  shellState.phone = true
  shellState.approvalFixture = true
  open('/b?job=job-notes', [
    { id: 'job-default', title: 'Team room', state: 'working', isDefault: true },
    { id: 'job-notes', title: 'Release notes', state: 'waiting_on_you', isDefault: false },
  ])
  const nav = screen.getByRole('navigation', { name: 'Main' })
  const room = within(nav).getByRole('button', { name: /^Chats/ })
  // The cached team-room read is already successful in this harness; the selected job has one approval to answer.
  await waitFor(() => expect(room.getAttribute('aria-label')).toBe('Chats, 1 need you'))
  const badge = room.querySelector('.bold-tab-count')
  expect(badge?.textContent).toBe('1')
  expect(badge?.getAttribute('data-protected')).toBe('inline-flex')
})

// 3.19.1 review: below 1100px the team rings hide, so the top bar's Room button carries the needs-you count (CSS shows it).
test('the desktop Room button carries the needs-you count, protected, for windows too narrow for the rings', async () => {
  shellState.approvalFixture = true
  open('/b?job=job-notes', [
    { id: 'job-default', title: 'Team room', state: 'working', isDefault: true },
    { id: 'job-notes', title: 'Release notes', state: 'waiting_on_you', isDefault: false },
  ])
  const nav = screen.getByRole('navigation', { name: 'Main' })
  const room = within(nav).getByRole('button', { name: /^Chats/ })
  await waitFor(() => expect(room.querySelector('.bold-nav-count')?.textContent).toBe('1'))
  expect(room.querySelector('.bold-nav-count')?.getAttribute('data-protected')).toBe('inline-flex')
})

test('the Terminal button shows only when the server offers a terminal, and Back returns', async () => {
  shellState.terminalFixture = { terminal: true, terminalUnavailable: null }
  const router = open('/b/agents')
  fireEvent.click(await screen.findByRole('button', { name: 'Terminal' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/terminal'))
  fireEvent.click(await screen.findByRole('button', { name: '← Back' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/agents'))
})

test('no Terminal button when the terminal is off or unavailable', async () => {
  shellState.terminalFixture = { terminal: true, terminalUnavailable: 'The terminal needs HTTPS.' }
  open('/b')
  await screen.findByRole('button', { name: 'Settings' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(screen.queryByRole('button', { name: 'Terminal' })).toBeNull()
  cleanup()
  shellState.terminalFixture = { terminal: false, terminalUnavailable: null }
  open('/b')
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(screen.queryByRole('button', { name: 'Terminal' })).toBeNull()
})

test('Ctrl+` opens the terminal and returns, but not while typing', async () => {
  shellState.terminalFixture = { terminal: true, terminalUnavailable: null }
  const router = open('/b/agents')
  await screen.findByRole('button', { name: 'Terminal' })
  const field = document.body.appendChild(document.createElement('input'))
  fireEvent.keyDown(field, { key: '`', ctrlKey: true })
  expect(router.state.location.pathname).toBe('/b/agents')
  field.remove()
  fireEvent.keyDown(document.body, { key: '`', ctrlKey: true })
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/terminal'))
  fireEvent.keyDown(document.body, { key: '`', metaKey: true })
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/agents'))
})

// was: 'opening the same run again after the phone sheet was closed opens the sheet again'
test('an old ?run= address lands on the Recipes page’s run every time, even the same one again', async () => {
  shellState.phone = true
  const router = open('/b?run=brief-x')
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/settings/recipes'))
  expect(router.state.location.search).toBe('?run=brief-x')
  await act(async () => {
    await router.navigate('/b')
  })
  await act(async () => {
    await router.navigate('/b?run=brief-x')
  })
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/settings/recipes'))
  expect(router.state.location.search).toBe('?run=brief-x')
  // The side sheet is not what opens for a run any more.
  expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull()
})

// was: 'a Library note request is consumed and can be repeated after another mode'
test('?note= and ?library=1 open Knowledge instead, and can be repeated', async () => {
  const router = open('/b?note=Decisions%2FSource.md')
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/knowledge'))
  expect(router.state.location.search).toBe('?note=Decisions%2FSource.md')
  expect(await screen.findByLabelText('Contents of Decisions/Source.md')).toBeDefined()

  await act(async () => {
    await router.navigate('/b')
  })
  await act(async () => {
    await router.navigate('/b?note=Decisions%2FSource.md')
  })
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/knowledge'))
  expect(router.state.location.search).toBe('?note=Decisions%2FSource.md')

  await act(async () => {
    await router.navigate('/b')
  })
  await act(async () => {
    await router.navigate('/b?library=1')
  })
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/knowledge'))
  expect(router.state.location.search).toBe('')
})

test('/runs/:id opens the run on the Recipes page, keeping other parameters', async () => {
  const router = open('/runs/brief-x?from=search')
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/settings/recipes'))
  expect(new URLSearchParams(router.state.location.search).get('run')).toBe('brief-x')
  expect(new URLSearchParams(router.state.location.search).get('from')).toBe('search')
})
