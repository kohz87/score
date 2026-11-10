// Decision 183: a saved recipe's Repeats card (none, set, paused, missed, failed, stop asks first, editing) and the
// recipes list beside it.
import type { RecipeSchedule } from '@score/contract'
import { ORCH_ACKNOWLEDGEMENT_TEXT } from '@score/contract'
import { workflowPreflight } from './BoldStartJob-helpers.tsx'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { setUpRecipeTests } from './BoldRecipes-helpers.tsx'

const { json, mount, onRequest, requests } = setUpRecipeTests()

const room = {
  id: 'room-release',
  name: '#release',
  kind: 'room',
  leadAgentId: null,
  members: [],
  unread: 0,
  activeAgents: [],
  channels: [],
}
const base: RecipeSchedule = {
  workflowId: 'wf-release',
  recipeName: 'Release notes',
  schedule: '0 16 * * 5',
  timezone: 'UTC',
  roomId: 'room-release',
  roomName: '#release',
  enabled: true,
  nextRunAt: '2026-11-13T16:00:00.000Z',
  lastRun: null,
}

/** The server's side of the schedule: one recipe's, kept between requests like the real one. */
function serve(initial: RecipeSchedule | null) {
  let current = initial
  const calls: { method: string; url: string; body: unknown }[] = []
  onRequest((url, init) => {
    const method = init?.method ?? 'GET'
    if (url === '/api/rooms') return json({ asOfSeq: 1, rooms: [room], directs: [], projects: [] })
    if (url === '/api/recipe-schedules') return json({ items: current ? [current] : [] })
    // What a schedule is bound to: the agents the recipe would run with now (decision 183).
    if (url.startsWith('/api/workflow-runs/preflight')) return json(workflowPreflight)
    if (url === '/api/workflows/wf-release/schedule' && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as Partial<RecipeSchedule>
      calls.push({ method, url, body })
      current = { ...base, ...body, roomName: '#release' }
      return json(current)
    }
    if (url === '/api/workflows/wf-release/schedule' && method === 'DELETE') {
      calls.push({ method, url, body: null })
      current = null
      return json({ workflowId: 'wf-release' })
    }
    if (url === '/api/workflows/wf-release/schedule/run') {
      calls.push({ method, url, body: null })
      return json(current)
    }
    return undefined
  })
  return calls
}

const card = () => screen.findByRole('region', { name: 'Repeats' })

test('a recipe that does not repeat says so and offers "Repeat it…"', async () => {
  serve(null)
  mount()
  const repeats = await card()
  expect(await within(repeats).findByText('Doesn’t repeat.')).toBeDefined()
  expect(within(repeats).getByRole('button', { name: 'Repeat it…' })).toBeDefined()
})

test('Repeat it… sets a schedule: the preset, a time, the browser’s time zone and the chat', async () => {
  const calls = serve(null)
  mount()
  const repeats = await card()
  fireEvent.click(await within(repeats).findByRole('button', { name: 'Repeat it…' }))
  fireEvent.change(within(repeats).getByLabelText('Repeat'), { target: { value: 'weekdays' } })
  fireEvent.change(within(repeats).getByLabelText('At'), { target: { value: '09:30' } })
  const save = within(repeats).getByRole('button', { name: 'Save schedule' }) as HTMLButtonElement
  // A chat is needed before it can be saved.
  expect(save.disabled).toBe(true)
  await within(repeats).findByRole('option', { name: '#release' })
  fireEvent.change(within(repeats).getByLabelText('Each run starts a job in'), {
    target: { value: 'room-release' },
  })
  // The acknowledgement is needed too, as when starting a run.
  expect(save.disabled).toBe(true)
  fireEvent.click(within(repeats).getByRole('checkbox', { name: ORCH_ACKNOWLEDGEMENT_TEXT }))
  await waitFor(() => expect(save.disabled).toBe(false))
  fireEvent.click(save)
  await waitFor(() => expect(calls).toHaveLength(1))
  expect(calls[0]!.body).toEqual({
    schedule: '30 9 * * 1-5',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    roomId: 'room-release',
    enabled: true,
    agentMap: [{ agentId: 'builder', incarnation: 'inc-1' }],
    acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
  })
  expect(await within(repeats).findByText('Weekdays at 09:30')).toBeDefined()
})

test('a schedule reads in words with its next run, the chat, and Score having to be running', async () => {
  serve(base)
  mount()
  const repeats = await card()
  expect(await within(repeats).findByText('Fridays at 16:00')).toBeDefined()
  expect(within(repeats).getByText(/next Fri 13 Nov, 16:00/)).toBeDefined()
  expect(within(repeats).getByText('On')).toBeDefined()
  expect(within(repeats).getByText('#release')).toBeDefined()
  expect(within(repeats).getByText(/Score has to be running/)).toBeDefined()
  expect(within(repeats).getByRole('button', { name: 'Change' })).toBeDefined()
})

test('Pause keeps the schedule and turns it off; Resume shows the agents and acknowledgement again, then turns it on', async () => {
  const calls = serve(base)
  mount()
  const repeats = await card()
  const pause = await within(repeats).findByRole('button', { name: 'Pause' })
  fireEvent.click(pause)
  await waitFor(() => expect(within(repeats).getByText('Paused')).toBeDefined())
  // Pausing sends no agents and no acknowledgement: the server keeps the binding it has.
  expect(calls[0]!.body).toEqual({
    schedule: '0 16 * * 5',
    timezone: 'UTC',
    roomId: 'room-release',
    enabled: false,
  })
  expect(within(repeats).getByText(/paused/)).toBeDefined()
  fireEvent.click(within(repeats).getByRole('button', { name: 'Resume' }))
  fireEvent.click(await within(repeats).findByRole('checkbox', { name: ORCH_ACKNOWLEDGEMENT_TEXT }))
  const save = within(repeats).getByRole('button', { name: 'Save schedule' }) as HTMLButtonElement
  await waitFor(() => expect(save.disabled).toBe(false))
  fireEvent.click(save)
  await waitFor(() => expect(within(repeats).getByText('On')).toBeDefined())
  expect(calls[1]!.body).toMatchObject({ enabled: true })
})

test('a missed run says Score wasn’t running, is protected, and Run now starts it', async () => {
  const calls = serve({
    ...base,
    lastRun: { at: '2026-11-06T16:00:00.000Z', outcome: 'missed', briefId: null, reason: null },
  })
  mount()
  const repeats = await card()
  const note = (
    await within(repeats).findByText(/Missed Fri 6 Nov, 16:00: Score wasn’t running/)
  ).closest('[data-protected]')
  expect(note).not.toBeNull()
  fireEvent.click(within(note as HTMLElement).getByRole('button', { name: 'Run now' }))
  await waitFor(() => expect(calls.some((call) => call.url.endsWith('/schedule/run'))).toBe(true))
})

test('a run that failed to start says why', async () => {
  serve({
    ...base,
    lastRun: {
      at: '2026-11-06T16:00:00.000Z',
      outcome: 'failed',
      briefId: null,
      reason: 'the chat was deleted',
    },
  })
  mount()
  const repeats = await card()
  expect(await within(repeats).findByText(/didn’t start: the chat was deleted/)).toBeDefined()
})

test('Stop repeating asks first; keeping it changes nothing, confirming removes the schedule', async () => {
  const calls = serve(base)
  mount()
  const repeats = await card()
  fireEvent.click(await within(repeats).findByRole('button', { name: 'Stop repeating' }))
  const ask = within(repeats).getByRole('group', { name: 'Stop repeating' })
  expect(ask.getAttribute('data-protected')).not.toBeNull()
  expect(calls).toHaveLength(0)
  fireEvent.click(within(ask).getByRole('button', { name: 'Keep it' }))
  expect(within(repeats).getByText('Fridays at 16:00')).toBeDefined()
  expect(calls).toHaveLength(0)
  fireEvent.click(within(repeats).getByRole('button', { name: 'Stop repeating' }))
  fireEvent.click(within(repeats).getByRole('button', { name: 'Yes, stop repeating' }))
  await waitFor(() =>
    expect(calls).toEqual([
      { method: 'DELETE', url: '/api/workflows/wf-release/schedule', body: null },
    ]),
  )
  expect(await within(repeats).findByText('Doesn’t repeat.')).toBeDefined()
})

test('the recipe sits under the Tasks tabs, with Before each run and Last runs beside it', async () => {
  serve(base)
  mount()
  const tabs = await screen.findByRole('navigation', { name: 'Tasks views' })
  expect(within(tabs).getByRole('link', { name: 'Recipes' }).getAttribute('aria-current')).toBe(
    'page',
  )
  expect(within(tabs).getByRole('link', { name: 'Board' }).getAttribute('href')).toBe('/b/tasks')
  expect(within(tabs).getByRole('link', { name: 'Repeating' }).getAttribute('href')).toBe(
    '/b/tasks/repeating',
  )
  expect(await screen.findByRole('region', { name: 'Before each run' })).toBeDefined()
  expect(await screen.findByRole('region', { name: 'Last runs' })).toBeDefined()
  // The list on the left: the recipe with its agents and when it repeats.
  const list = await screen.findByRole('navigation', { name: 'Recipes' })
  expect(await within(list).findByText(/repeats Fridays at 16:00/)).toBeDefined()
  expect(requests.some((request) => request.url === '/api/recipe-schedules')).toBe(true)
})

test('a new recipe has no Repeats card yet', async () => {
  serve(null)
  mount('/b/tasks/recipes/new')
  await screen.findByRole('navigation', { name: 'Tasks views' })
  await screen.findByRole('region', { name: 'Recipe editor' })
  expect(screen.queryByRole('region', { name: 'Repeats' })).toBeNull()
})
