import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { open, teamState } from './bold-team-helpers.tsx'

test('the agent page is one column of sections, with the section menu beside it and no More toggle', async () => {
  open('/b/agents/builder')
  expect(await screen.findByRole('heading', { name: 'builder', level: 1 })).toBeDefined()
  expect(screen.getByRole('heading', { name: 'Personality', level: 2 })).toBeDefined()
  expect(await screen.findByRole('textbox', { name: 'SOUL.md contents' })).toBeDefined()
  expect(screen.getByText('Hermes')).toBeDefined()
  expect(screen.getByText('Next model')).toBeDefined()
  expect(screen.getByText(/Falls back to demo\/safe/)).toBeDefined()
  expect(await screen.findByText(/This machine, as you · Not separated/)).toBeDefined()
  expect(screen.getByText('Asks you first before')).toBeDefined()
  expect(screen.getByText('Installing packages')).toBeDefined()
  expect(screen.getByText('Pushing code')).toBeDefined()
  expect(screen.getByText('Deleting files')).toBeDefined()
  expect(screen.getByText('Using the mouse and keyboard on its screen')).toBeDefined()
  // A rule set to Allowed is not something the agent asks about (Goes ahead lists it, on the same page now).
  const asks = screen.getByRole('region', { name: 'Asks you first before' })
  expect(within(asks).queryByText('SQL DROP')).toBeNull()
  expect(screen.getByText(/reports to/)).toBeDefined()
  expect(screen.getByRole('link', { name: 'lead' }).getAttribute('href')).toBe('/b/agents/lead')
  // The Workspace card and the header's "Works in" went with decision 180: the chat shows the workspace.
  expect(screen.queryByText('Works in')).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Workspace' })).toBeNull()
  expect(screen.getByRole('link', { name: 'Message' }).getAttribute('href')).toBe('/b?with=builder')
  expect(screen.getByRole('button', { name: 'Pause builder' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
  expect(screen.getByRole('menuitem', { name: 'Look at its screen' }).getAttribute('href')).toBe(
    '/b/screen/builder',
  )
  expect(screen.queryByRole('button', { name: 'Open builder in its own window' })).toBeNull()

  // No More/Less toggle: every card is on the page.
  expect(screen.queryByRole('button', { name: /^More: / })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Less' })).toBeNull()
  for (const title of [
    'Remembers',
    'Skills',
    'Can use',
    'Assigned',
    'Plugins',
    'Reachable on',
    'Never rules',
    'Recent runs',
    'Todo',
  ])
    expect(
      await screen.findByRole('heading', { name: new RegExp(`^${title}`), level: 3 }),
    ).toBeDefined()
  // None of the classic Team tab sections are used any more.
  expect(
    document.querySelector(
      '#agent-section-tools .team-card, #agent-work .team-card, #agent-memory-skills .team-card',
    ),
  ).toBeNull()
  expect(await screen.findByText('Nothing on its todo list.')).toBeDefined()
})

test('Asks you first checkboxes update the permission through the classic mutation', async () => {
  open('/b/agents/builder')
  // The tile lists what it asks about; its action opens the checkboxes in place.
  fireEvent.click(
    await screen.findByRole('button', { name: 'Change what it asks you first about' }),
  )
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

test('the header’s Edit offers name, role and the appearance editor', async () => {
  open('/b/agents/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Change name, role and look' }))
  expect(await screen.findByRole('heading', { name: 'Name and role', level: 3 })).toBeDefined()
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

test('a workspace link (?path=) opens the Files panel under Work', async () => {
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

  expect(screen.queryByRole('button', { name: /^More: / })).toBeNull()
  for (const title of ['Can use', 'Recent runs'])
    expect(
      await screen.findByRole('heading', { name: new RegExp(`^${title}`), level: 3 }),
    ).toBeDefined()
  expect(screen.queryByRole('heading', { name: /^Workspace/ })).toBeNull()
  expect(screen.queryByRole('heading', { name: /^Remembers/ })).toBeNull()
  expect(screen.getByRole('button', { name: 'Remove coder' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Change name, role and look' }))
  for (const title of ['Looks', 'Name and role'])
    expect(
      await screen.findByRole('heading', { name: new RegExp(`^${title}`), level: 3 }),
    ).toBeDefined()
})

test('Where it works says exactly what Docker separates and changes through the API', async () => {
  open('/b/agents/builder')
  const tile = await screen.findByRole('region', { name: 'Where it works' })
  expect(await within(tile).findByText(/Not separated/)).toBeDefined()
  expect(tile.getAttribute('data-protected')).toBe('block')
  // The tile's action opens the full card in place; its own button starts the change.
  fireEvent.click(within(tile).getByRole('button', { name: 'Change where it works' }))
  const card = await screen.findByRole('region', { name: 'Where it works' })
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

test('the status line keeps the state and who it reports to on one row', async () => {
  open('/b/agents/builder')
  await screen.findByText(/reports to/)
  const row = document.querySelector('.bold-agent-line')
  expect(row?.querySelector('.bold-agent-state')).not.toBeNull()
  expect(row?.querySelector('.bold-agent-state')?.textContent).toMatch(/reports to lead/)
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
