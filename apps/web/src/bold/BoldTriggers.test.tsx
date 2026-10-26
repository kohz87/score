import type { Trigger } from '@score/contract'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { BoldTriggers } from './BoldTriggers.tsx'
import { renderInRoom } from './room/room-test-utils.tsx'

const SECRET = `whsec_${'A'.repeat(43)}=`
const ROTATED = `whsec_${'B'.repeat(43)}=`

const trigger: Trigger = {
  id: 'trg_1',
  name: 'New support ticket',
  app: 'Tickets app',
  mapping: { ref: 'id' },
  template: 'A call from the app started a job.',
  reportBack: { mode: 'off' },
  url: 'http://127.0.0.1:5560/hooks/trg_1',
  sample: null,
  lastCalledAt: null,
  createdAt: '2026-10-24T10:00:00.000Z',
  teamRoomId: null,
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mount(items: Trigger[], teams: { id: string; name: string; archived?: boolean }[] = []) {
  let list = structuredClone(items)
  const calls: { path: string; method: string; body: unknown }[] = []
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ path: url.pathname, method, body })
    if (url.pathname === '/api/team-rooms')
      return Promise.resolve(
        Response.json({
          asOfSeq: 1,
          items: teams.map((team, index) => ({
            ...team,
            kind: 'room',
            leadAgentId: null,
            members: [],
            unread: 0,
            activeAgents: [],
            channels: [],
            role: 'team',
            everyone: index === 0,
          })),
        }),
      )
    if (url.pathname === '/api/triggers' && method === 'GET')
      return Promise.resolve(Response.json({ items: list }))
    if (url.pathname === '/api/triggers/trg_1/secret' && method === 'GET')
      return Promise.resolve(Response.json({ secret: SECRET }))
    if (url.pathname === '/api/triggers/trg_1/rotate' && method === 'POST')
      return Promise.resolve(Response.json({ secret: ROTATED }))
    if (url.pathname === '/api/triggers/trg_1' && method === 'DELETE') {
      list = []
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    if (url.pathname === '/api/triggers' && method === 'POST') {
      list = [structuredClone(trigger)]
      return Promise.resolve(
        Response.json({ trigger: structuredClone(trigger), secret: SECRET }, { status: 201 }),
      )
    }
    if (url.pathname === '/api/triggers/trg_1' && method === 'PATCH') {
      if (
        (body as { reportBack?: { args?: string } })?.reportBack?.args?.includes('{{source.ref}}}')
      )
        return Promise.resolve(
          Response.json(
            { error: { code: 'bad_template', message: 'Holes must sit inside strings.' } },
            { status: 400 },
          ),
        )
      const updated: Trigger = { ...trigger, ...(body as object), url: trigger.url } as Trigger
      list = [updated]
      return Promise.resolve(Response.json(updated))
    }
    return Promise.resolve(
      Response.json({ error: { code: 'not_found', message: 'No' } }, { status: 404 }),
    )
  })
  vi.stubGlobal('fetch', fetch)
  const { queryClient: client } = renderInRoom(<BoldTriggers appSuggestions={['Tickets app']} />, [
    '/b',
  ])
  return { calls, client, setList: (next: Trigger[]) => (list = next) }
}

test('a trigger card shows its address, and Show secret again reads it without caching it', async () => {
  const { calls, client } = mount([trigger])
  expect(await screen.findByText('New support ticket')).toBeDefined()
  const card = document.querySelector('[data-trigger-id="trg_1"]')!
  expect(card.getAttribute('data-protected')).toBe('flex')
  expect(card.textContent).toContain('/hooks/trg_1')

  fireEvent.click(screen.getByRole('button', { name: 'Show secret again' }))
  expect(await screen.findByText(SECRET)).toBeDefined()
  expect(document.querySelector('[data-trigger-secret]')?.textContent).toBe(SECRET)
  expect(calls.some((call) => call.path === '/api/triggers/trg_1/secret')).toBe(true)
  expect(JSON.stringify(client.getQueryData(['settings', 'triggers']))).not.toContain(SECRET)
  fireEvent.click(screen.getByRole('button', { name: 'Close secret' }))
  await waitFor(() => expect(document.querySelector('[data-trigger-secret]')).toBeNull())
})

test('rotate and delete confirm first; rotate shows the new secret, delete removes the card', async () => {
  const { calls, setList } = mount([trigger])
  await screen.findByText('New support ticket')

  fireEvent.click(screen.getByRole('button', { name: 'Rotate secret' }))
  const rotate = screen.getByRole('alertdialog', { name: 'Rotate the secret?' })
  expect(rotate.getAttribute('data-protected')).toBe('flex')
  expect(rotate.textContent).toContain('old secret stops working immediately')
  fireEvent.click(within(rotate).getByRole('button', { name: 'Rotate secret' }))
  expect(await screen.findByText(ROTATED)).toBeDefined()
  expect(calls.some((call) => call.path === '/api/triggers/trg_1/rotate')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Close secret' }))

  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  const remove = screen.getByRole('alertdialog', { name: 'Delete this trigger?' })
  expect(remove.textContent).toContain('Past jobs stay in the team room.')
  setList([])
  fireEvent.click(within(remove).getByRole('button', { name: 'Delete trigger' }))
  expect(await screen.findByText(/Deleted New support ticket/)).toBeDefined()
  await waitFor(() => expect(document.querySelector('[data-trigger-id="trg_1"]')).toBeNull())
  expect(
    calls.some((call) => call.path === '/api/triggers/trg_1' && call.method === 'DELETE'),
  ).toBe(true)
})

test('a new trigger is made through the four steps, the secret is shown once, and bad_template is plain', async () => {
  const { calls, setList } = mount([])
  fireEvent.click(screen.getByRole('button', { name: 'New trigger' }))
  const dialog = screen.getByRole('dialog', { name: 'New trigger' })
  expect(dialog.textContent).toContain('Set up')
  fireEvent.change(within(dialog).getByLabelText('Name'), {
    target: { value: 'New support ticket' },
  })
  fireEvent.change(within(dialog).getByLabelText('App it comes from'), {
    target: { value: 'Tickets app' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create the address' }))

  expect(await within(dialog).findByText(SECRET)).toBeDefined()
  expect(dialog.textContent).toContain('Test call')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close secret' }))
  await waitFor(() => expect(document.querySelector('[data-trigger-secret]')).toBeNull())

  setList([
    {
      ...trigger,
      sample: { id: 'TCK-9', title: 'Export does nothing', body: 'Safari 18 fails.' },
    },
  ])
  fireEvent.click(within(dialog).getByRole('button', { name: 'Check again' }))
  expect(await within(dialog).findByText('Test call received')).toBeDefined()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Map fields' }))
  expect(dialog.textContent).toContain('Map fields')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Guess from field names' }))
  expect(
    (within(dialog).getByLabelText('What the job asks the team to do') as HTMLTextAreaElement)
      .value,
  ).toContain('{{title}}')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }))

  expect(dialog.textContent).toContain('Report back')
  fireEvent.click(within(dialog).getByLabelText(/Post with a tool every time/))
  fireEvent.change(within(dialog).getByLabelText('Tool name'), {
    target: { value: 'add_comment' },
  })
  fireEvent.change(within(dialog).getByLabelText('Arguments template (JSON)'), {
    target: { value: '{"id": {{source.ref}}}' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save trigger' }))
  expect((await within(dialog).findByRole('alert')).textContent).toContain(
    'must be JSON, and every {{…}} must be inside a quoted string',
  )

  fireEvent.change(within(dialog).getByLabelText('Arguments template (JSON)'), {
    target: { value: '{"id": "{{source.ref}}"}' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save trigger' }))
  expect(await screen.findByText(/Trigger saved. The next call from Tickets app/)).toBeDefined()
  expect(screen.queryByRole('dialog', { name: 'New trigger' })).toBeNull()
  const patch = calls
    .filter((call) => call.path === '/api/triggers/trg_1' && call.method === 'PATCH')
    .at(-1)
  expect(patch?.body).toMatchObject({
    name: 'New support ticket',
    app: 'Tickets app',
    mapping: { ref: 'id', title: 'title', details: 'body' },
    reportBack: { mode: 'fixed', tool: 'add_comment', args: '{"id": "{{source.ref}}"}' },
  })
})

test('going back to the first step after the address exists does not create a second trigger', async () => {
  const { calls } = mount([])
  fireEvent.click(screen.getByRole('button', { name: 'New trigger' }))
  const dialog = screen.getByRole('dialog', { name: 'New trigger' })
  fireEvent.change(within(dialog).getByLabelText('Name'), {
    target: { value: 'New support ticket' },
  })
  fireEvent.change(within(dialog).getByLabelText('App it comes from'), {
    target: { value: 'Tickets app' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create the address' }))
  await within(dialog).findByText(SECRET)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }))
  expect(within(dialog).getByRole('button', { name: 'Next' })).toBeDefined()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }))
  expect(dialog.getAttribute('data-trigger-step')).toBe('2')
  expect(
    calls.filter((call) => call.path === '/api/triggers' && call.method === 'POST'),
  ).toHaveLength(1)
})

test('a never-called trigger shows when it was created; a risky report-back tool shows its warning', async () => {
  mount([
    {
      ...trigger,
      reportBack: { mode: 'fixed', tool: 'tickets_close', args: '{}' },
      warning: 'This tool may change things, not just report.',
    },
  ])
  const card = (await screen.findByText('New support ticket')).closest('article')!
  expect(card.textContent).toContain('last call never · created ')
  expect(within(card).getByRole('note').textContent).toContain('may change things')
})

const TWO_TEAMS = [
  { id: 'room-1', name: 'Team room' },
  { id: 'room-docs', name: 'Docs team' },
]

test('with one team room a trigger has no team choice and sends no team', async () => {
  const { calls } = mount([])
  fireEvent.click(screen.getByRole('button', { name: 'New trigger' }))
  const dialog = screen.getByRole('dialog', { name: 'New trigger' })
  expect(within(dialog).queryByLabelText('Starts jobs in')).toBeNull()
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'T' } })
  fireEvent.change(within(dialog).getByLabelText('App it comes from'), { target: { value: 'A' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create the address' }))
  await within(dialog).findByText(SECRET)
  const post = calls.find((call) => call.path === '/api/triggers' && call.method === 'POST')
  expect(post?.body).not.toHaveProperty('teamRoomId')
})

test('with two team rooms a new trigger can start jobs in the second, and its card says so', async () => {
  const { calls } = mount([], TWO_TEAMS)
  fireEvent.click(screen.getByRole('button', { name: 'New trigger' }))
  const dialog = screen.getByRole('dialog', { name: 'New trigger' })
  const select = (await within(dialog).findByLabelText('Starts jobs in')) as HTMLSelectElement
  expect(select.value).toBe('room-1')
  fireEvent.change(select, { target: { value: 'room-docs' } })
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'T' } })
  fireEvent.change(within(dialog).getByLabelText('App it comes from'), { target: { value: 'A' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create the address' }))
  await within(dialog).findByText(SECRET)
  const post = calls.find((call) => call.path === '/api/triggers' && call.method === 'POST')
  expect(post?.body).toMatchObject({ teamRoomId: 'room-docs' })
})

test('a trigger card names its team only when several exist and it is not the first', async () => {
  mount([{ ...trigger, teamRoomId: 'room-docs' }], TWO_TEAMS)
  const card = (await screen.findByText('New support ticket')).closest('article')!
  await waitFor(() => expect(card.textContent).toContain('Starts jobs in Docs team.'))
  cleanup()
  mount([trigger], TWO_TEAMS)
  const plain = (await screen.findByText('New support ticket')).closest('article')!
  expect(plain.textContent).not.toContain('Starts jobs in')
})
