import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { open, teamState } from './bold-team-helpers.tsx'

test('the agent page puts the four cards first and the compact More cards under the toggle', async () => {
  open('/b/agents/builder')
  expect(await screen.findByRole('heading', { name: 'builder', level: 1 })).toBeDefined()
  expect(screen.getByText('How builder works')).toBeDefined()
  expect(await screen.findByRole('textbox', { name: 'SOUL.md contents' })).toBeDefined()
  expect(screen.getByText('Hermes')).toBeDefined()
  expect(screen.getByText('Next model')).toBeDefined()
  expect(screen.getByText(/Falls back to demo\/safe/)).toBeDefined()
  expect(await screen.findByText('This machine, as you')).toBeDefined()
  expect(screen.getByText('Not separated')).toBeDefined()
  expect(screen.getByText('Asks you first before')).toBeDefined()
  expect(screen.getByText('Installing packages')).toBeDefined()
  expect(screen.getByText('Pushing code')).toBeDefined()
  expect(screen.getByText('Deleting files')).toBeDefined()
  expect(screen.getByText('Using the mouse and keyboard on its screen')).toBeDefined()
  // A rule set to Allowed is not something the agent asks about.
  expect(screen.queryByText('SQL DROP')).toBeNull()
  expect(screen.getByText('Reports to')).toBeDefined()
  expect(screen.getByRole('link', { name: 'lead' }).getAttribute('href')).toBe('/b/agents/lead')
  expect(screen.getByText('Works in')).toBeDefined()
  expect(screen.getByText('/srv/app')).toBeDefined()
  expect(screen.getByRole('link', { name: 'Message' }).getAttribute('href')).toBe('/b?with=builder')
  expect(screen.getByRole('button', { name: 'Pause builder' })).toBeDefined()
  expect(screen.getByRole('link', { name: 'Look at its screen' }).getAttribute('href')).toBe(
    '/b/screen/builder',
  )
  expect(screen.queryByRole('button', { name: 'Open builder in its own window' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: /^More: memory/ }))
  expect(screen.queryByRole('navigation', { name: 'Agent settings sections' })).toBeNull()
  const more = await screen.findByRole('button', { name: 'Less' })
  expect(more.getAttribute('aria-expanded')).toBe('true')
  for (const title of [
    'Remembers',
    'Skills',
    'Can use',
    'Workspace',
    'Repeating jobs',
    'Delete builder',
    'Plugins',
    'Channels',
    'Never rules',
    'Looks',
    'Name and role',
    'Recent runs',
    'Todo',
  ])
    expect(
      await screen.findByRole('heading', { name: new RegExp(`^${title}`), level: 3 }),
    ).toBeDefined()
  // None of the classic Team tab sections are used any more.
  expect(document.querySelector('#agent-more .team-card')).toBeNull()
  expect(await screen.findByText('Nothing on its todo list.')).toBeDefined()
})

test('Asks you first checkboxes update the permission through the classic mutation', async () => {
  open('/b/agents/builder')
  const asks = await screen.findByRole('region', { name: 'Asks you first before' })
  const install = within(asks).getByRole('checkbox', { name: 'Installing packages' })
  expect((install as HTMLInputElement).checked).toBe(true)
  expect(asks.getAttribute('data-protected')).toBe('block')
  fireEvent.click(install)
  await waitFor(() => {
    const call = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) =>
          String(input).endsWith('/api/agents/builder/permissions/install%20packages') &&
          init?.method === 'PATCH',
      )
    expect(call).toBeDefined()
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ level: 'allowed' })
  })
})

test('More offers the appearance editor', async () => {
  open('/b/agents/builder')
  fireEvent.click(await screen.findByRole('button', { name: /^More: memory/ }))
  const appearance = document.querySelector('#agent-appearance')!
  fireEvent.click(
    within(appearance as HTMLElement).getByRole('button', {
      name: /Change builder.s colour and shape/,
    }),
  )
  expect(await screen.findByRole('dialog', { name: 'Agent appearance' })).toBeDefined()
  expect(screen.getByRole('radio', { name: 'star' })).toBeDefined()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog', { name: 'Agent appearance' })).toBeNull()
})

test('a workspace link (?path=) opens More and the Files panel', async () => {
  open('/b/agents/builder?path=docs%2Fplan.md')
  expect(await screen.findByRole('heading', { name: 'Files' })).toBeDefined()
  expect(document.querySelector('#agent-files')).not.toBeNull()
})

test('an agent that cannot load says so and offers a retry', async () => {
  teamState.detailReply = () =>
    Response.json({ error: { code: 'not_found', message: 'gone' } }, { status: 404 })
  open('/b/agents/builder')
  expect(await screen.findByRole('heading', { name: 'Agent unavailable' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined()
})

test('a coding agent gets access, quota, password and the protected Codex note on the same page', async () => {
  open('/b/agents/coder')
  expect(await screen.findByRole('heading', { name: 'coder', level: 1 })).toBeDefined()
  expect(await screen.findByRole('heading', { name: 'Access' })).toBeDefined()
  expect(await screen.findByRole('heading', { name: 'Limits left' })).toBeDefined()
  expect(screen.queryByRole('heading', { name: 'Codex read access' })).toBeNull()
  const reach = screen.getByRole('note')
  expect(reach.getAttribute('data-protected')).toBe('any')
  expect(reach.textContent).toContain('Codex can read every file your user can')
  expect(screen.getByText(/Runs stop using it below 10% of a limit left/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Change access' }))
  fireEvent.click(screen.getByRole('radio', { name: /Full access/ }))
  expect(await screen.findByLabelText('Security password')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

  fireEvent.click(screen.getByRole('button', { name: /^More: tools, workspace, delete/ }))
  expect(screen.queryByRole('navigation', { name: 'Agent settings sections' })).toBeNull()
  for (const title of [
    'Can use',
    'Workspace',
    'Recent runs',
    'Looks',
    'Name and role',
    'Delete coder',
  ])
    expect(
      await screen.findByRole('heading', { name: new RegExp(`^${title}`), level: 3 }),
    ).toBeDefined()
  expect(screen.queryByRole('heading', { name: /^Remembers/ })).toBeNull()
})

test('Where it works says exactly what Docker separates and changes through the API', async () => {
  open('/b/agents/builder')
  const card = await screen.findByRole('region', { name: 'Where it works' })
  expect(await within(card).findByText('Not separated')).toBeDefined()
  expect(card.getAttribute('data-protected')).toBe('block')
  fireEvent.click(within(card).getByRole('button', { name: 'Change where it works' }))
  fireEvent.click(within(card).getByRole('radio', { name: 'Docker' }))
  fireEvent.click(
    within(card).getByRole('checkbox', { name: 'Let the container reach the network' }),
  )
  fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
  expect(await within(card).findByText('Partly separated')).toBeDefined()
  expect(teamState.runsOnPuts).toEqual([{ backend: 'docker', network: false }])
  expect(within(card).getByText(/Still on this machine as you:/)).toBeDefined()
  expect(within(card).getByText(/MCP servers/)).toBeDefined()
  expect(within(card).getByText('Commands run as root inside the container.')).toBeDefined()
})

test('the agent page keeps "needs you" and the overview facts on one row', async () => {
  open('/b/agents/builder')
  await screen.findByText('Reports to')
  const row = document.querySelector('.bold-agent-now')
  expect(row?.querySelector('.bold-agent-state')).not.toBeNull()
  expect(row?.querySelector('.bold-agent-facts')).not.toBeNull()
})

test('a coding agent’s Model card names the chats its effort is set differently in, and nothing when none is', async () => {
  const base = vi.mocked(fetch).getMockImplementation()!
  const efforts = (chats: unknown[]) =>
    Response.json({
      agentId: 'coder',
      own: 'high',
      levels: ['low', 'high', 'max'],
      chats,
    })
  vi.mocked(fetch).mockImplementation((input, init) =>
    String(input).endsWith('/api/agents/coder/efforts')
      ? Promise.resolve(
          efforts([
            {
              roomId: 'room-2',
              roomName: 'Ship it',
              roomKind: 'group',
              jobTitle: null,
              effort: 'max',
            },
          ]),
        )
      : base(input, init),
  )
  open('/b/agents/coder')
  expect(await screen.findByText('Set differently in 1 chat')).toBeDefined()
  expect(screen.getByRole('link', { name: 'Ship it' })).toBeDefined()
  expect(screen.getByText(/Every other chat uses high/)).toBeDefined()
})

test('a coding agent shows no "Set differently" card when no chat sets its effort', async () => {
  const base = vi.mocked(fetch).getMockImplementation()!
  let asked = false
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (String(input).endsWith('/api/agents/coder/efforts')) {
      asked = true
      return Promise.resolve(
        Response.json({ agentId: 'coder', own: 'high', levels: ['low', 'high', 'max'], chats: [] }),
      )
    }
    return base(input, init)
  })
  open('/b/agents/coder')
  expect(await screen.findByRole('heading', { name: 'coder', level: 1 })).toBeDefined()
  await waitFor(() => expect(asked).toBe(true))
  expect(screen.queryByText(/Set differently in/)).toBeNull()
})
