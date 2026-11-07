import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, test } from 'vitest'
import { calls, open, settingsState } from './BoldSettings-helpers.tsx'

test('System shows service, updates, backups, logs, Library access, Shares, Terminal and Pause everyone', async () => {
  open('/b/settings/system')
  expect(await screen.findByRole('heading', { name: 'System' })).toBeDefined()
  expect(await screen.findByRole('heading', { name: 'Score' })).toBeDefined()
  expect(await screen.findByText('Score v1.14.0')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
  expect(await screen.findByText(/You’re up to date/)).toBeDefined()
  expect(screen.getByRole('heading', { name: 'Backups' })).toBeDefined()
  expect(screen.getByText(/scripts\/score restore/)).toBeDefined()
  expect(await screen.findByText('approval requested')).toBeDefined()
  expect(screen.getByRole('heading', { name: 'Shares' })).toBeDefined()
  expect(screen.getByText('No share links yet. Make one from a room’s menu in Chat.')).toBeDefined()
  const facts = screen.getByText('Knowledge folder').closest('dl')!
  expect(facts.textContent).toContain('/tmp/score-vault')
  expect(facts.textContent).toContain('2 files, 2 KB')
  expect(facts.textContent).toContain('Versioned with git: every save is a commit.')
  expect(await screen.findByText('Agent writes today')).toBeDefined()
  expect(screen.getByText('builder')).toBeDefined()
  expect(screen.getByText('3 writes')).toBeDefined()
  const library = (await screen.findByRole('switch', {
    name: 'Agents can use Library',
  })) as HTMLInputElement
  expect(library.checked).toBe(false)
  fireEvent.click(library)
  await waitFor(() =>
    expect(
      calls.some((call) => call.url === '/api/knowledge/settings' && call.method === 'PUT'),
    ).toBe(true),
  )
  await waitFor(() => expect(library.checked).toBe(true))
  const memory = screen.getByRole('switch', {
    name: 'Save compacted summaries as memory notes',
  }) as HTMLInputElement
  expect(memory.checked).toBe(true)
  fireEvent.click(memory)
  await waitFor(() =>
    expect(
      calls.filter((call) => call.url === '/api/knowledge/settings' && call.method === 'PUT').at(-1)
        ?.body,
    ).toEqual({ memoryNotes: false }),
  )
  await waitFor(() =>
    expect(
      (
        screen.getByRole('switch', {
          name: 'Save compacted summaries as memory notes',
        }) as HTMLInputElement
      ).checked,
    ).toBe(false),
  )
  expect(screen.getByRole('link', { name: 'Open the terminal' }).getAttribute('href')).toBe(
    '/terminal',
  )
  expect(screen.getByRole('link', { name: 'Open Library' }).getAttribute('href')).toBe(
    '/b?library=1',
  )
  fireEvent.click(screen.getByRole('button', { name: 'Pause everyone' }))
  expect(await screen.findByRole('button', { name: 'Resume everyone' })).toBeDefined()
})

test('System shows the fence review in Backups, and lifting it removes the review', async () => {
  settingsState.fenced = true
  open('/b/settings/system')
  expect(
    await screen.findByRole('heading', {
      name: 'Starting work is blocked until you review this list',
    }),
  ).toBeDefined()
  expect(screen.getByText(/No orchestration starts anything new/)).toBeDefined()
  fireEvent.click(screen.getByRole('checkbox', { name: /I’ve been through this list/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Lift the block' }))
  await waitFor(() =>
    expect(
      screen.queryByRole('heading', {
        name: 'Starting work is blocked until you review this list',
      }),
    ).toBeNull(),
  )
  expect(screen.getByText(/Nothing is blocked/)).toBeDefined()
  expect(settingsState.fenced).toBe(false)
})
