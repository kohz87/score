import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { expect, test } from 'vitest'
import { TasksTabs } from '../tasks-tabs/TasksTabs.tsx'
import { job, mount, repeating as state, sent } from './repeating-helpers.tsx'

const recipe = (extra: Record<string, unknown> = {}) => ({
  workflowId: 'wf1',
  recipeName: 'Release notes',
  schedule: '0 16 * * 5',
  timezone: 'UTC',
  roomId: 'room-a',
  roomName: '#release',
  enabled: true,
  nextRunAt: null,
  lastRun: null,
  ...extra,
})

function seed() {
  state.jobs = [
    job('b1', 'builder', {
      title: 'Morning summary',
      description: 'Summarise yesterday',
      deliverTo: { roomId: 'room-a', roomName: 'Team room' },
    }),
    job('b2', 'builder', { title: 'Dependency check', schedule: '0 9 * * 1', enabled: false }),
    job('l1', 'lead', { title: 'Weekly report', model: 'deep', schedule: 'every 2h' }),
  ]
  state.schedules = [recipe()]
}

test('the list shows jobs and recipes with schedule words, model, results and state', async () => {
  seed()
  mount()
  const table = await screen.findByRole('table')
  const rows = within(table).getAllByRole('row')
  expect(rows).toHaveLength(5)
  const morning = within(rows[1]!)
  expect(morning.getByText('Morning summary')).toBeTruthy()
  expect(morning.getByText('Summarise yesterday')).toBeTruthy()
  expect(morning.getByText('Every day, 08:00')).toBeTruthy()
  expect(await morning.findByText('its own · demo-model')).toBeTruthy()
  expect(morning.getByText('Team room')).toBeTruthy()
  expect(morning.getByText('On')).toBeTruthy()
  expect(within(rows[2]!).getByText('Mondays, 09:00')).toBeTruthy()
  expect(within(rows[2]!).getByText('Paused')).toBeTruthy()
  expect(within(rows[2]!).getByText('Just the run')).toBeTruthy()
  expect(within(rows[3]!).getByText('Every 2 hours')).toBeTruthy()
  const pinned = within(rows[3]!).getByText('deep · pinned')
  expect(pinned.className).toContain('is-pinned')
  const release = within(rows[4]!)
  expect(release.getByText('per step')).toBeTruthy()
  expect(release.getByRole('link', { name: 'Recipe · Release notes' }).getAttribute('href')).toBe(
    '/b/tasks/recipes/wf1',
  )
  expect(release.getByRole('link', { name: 'Edit Release notes' })).toBeTruthy()
})

test('chips filter by agent and recipes, with counts', async () => {
  seed()
  mount()
  await screen.findByRole('table')
  const chips = screen.getByRole('group', { name: 'Assigned to' })
  for (const name of ['Everyone · 4', 'builder · 2', 'lead · 1', 'Recipes · 1'])
    expect(within(chips).getByRole('button', { name })).toBeTruthy()
  fireEvent.click(within(chips).getByRole('button', { name: 'builder · 2' }))
  expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3)
  fireEvent.click(within(chips).getByRole('button', { name: 'Recipes · 1' }))
  expect(screen.queryByText('Morning summary')).toBeNull()
  expect(screen.getByText('Release notes')).toBeTruthy()
})

test('a missed or failed recipe run says so in words, as a protected note', async () => {
  state.schedules = [
    recipe({
      lastRun: { at: new Date().toISOString(), outcome: 'missed', briefId: null, reason: null },
    }),
    recipe({
      workflowId: 'wf2',
      recipeName: 'Other',
      lastRun: {
        at: new Date().toISOString(),
        outcome: 'failed',
        briefId: null,
        reason: 'The chat is gone.',
      },
    }),
  ]
  mount()
  const missed = await screen.findByText(/Missed .*Score wasn’t running/)
  expect(missed.getAttribute('data-protected')).toBe('block')
  expect(screen.getByText(/Failed .*The chat is gone\./)).toBeTruthy()
})

test('agents whose jobs could not be read are named', async () => {
  seed()
  state.unreadable = ['reviewer']
  mount()
  const alert = await screen.findByText(/Couldn’t read the jobs of reviewer/)
  expect(alert.getAttribute('role')).toBe('alert')
})

test('Run now posts once with a key; a recipe runs through its schedule', async () => {
  seed()
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Run Morning summary now' }))
  await waitFor(() => expect(sent('POST', '/api/routines/')).toHaveLength(1))
  const run = sent('POST', '/api/routines/')[0]!
  expect(run.path).toBe('/api/routines/b1/run')
  expect(run.key).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Run Release notes now' }))
  await waitFor(() => expect(sent('POST', '/api/workflows/')).toHaveLength(1))
  expect(sent('POST', '/api/workflows/')[0]).toMatchObject({
    path: '/api/workflows/wf1/schedule/run',
    body: {},
  })
  expect(await screen.findByText('Started Release notes.')).toBeTruthy()
})

test('an empty list says so and still offers the new job', async () => {
  mount()
  expect(await screen.findByText(/No repeating jobs yet/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'New repeating job' })).toBeTruthy()
})

test('the tabs are links with the current one marked', () => {
  const router = createMemoryRouter([{ path: '*', element: <TasksTabs /> }], {
    initialEntries: ['/b/tasks/repeating'],
  })
  render(<RouterProvider router={router} />)
  const nav = screen.getByRole('navigation', { name: 'Tasks views' })
  expect(within(nav).getByRole('link', { name: 'Board' }).getAttribute('href')).toBe('/b/tasks')
  expect(within(nav).getByRole('link', { name: 'Repeating' }).getAttribute('aria-current')).toBe(
    'page',
  )
  expect(within(nav).getByRole('link', { name: 'Board' }).getAttribute('aria-current')).toBeNull()
  expect(within(nav).getByRole('link', { name: 'Recipes' }).getAttribute('href')).toBe(
    '/b/tasks/recipes',
  )
})

test('on a phone the list is cards', async () => {
  seed()
  state.phone = true
  mount()
  const cards = await screen.findAllByRole('listitem')
  expect(cards).toHaveLength(4)
  expect(screen.queryByRole('table')).toBeNull()
  expect(within(cards[0]!).getByText('Every day, 08:00')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'New repeating job' }).textContent).toBe('+')
})

test('the phone styles make every control 44px', () => {
  const list = readFileSync(join(__dirname, './bold-repeating-list.css'), 'utf8')
  const tabs = readFileSync(join(__dirname, '../tasks-tabs/tasks-tabs.css'), 'utf8')
  const panel = readFileSync(join(__dirname, './bold-repeating-panel.css'), 'utf8')
  const phone = (css: string) => css.slice(css.indexOf('@media (max-width: 600px)'))
  expect(phone(list)).toMatch(/\.bold-rj-new \{[^}]*width: 44px/)
  expect(phone(list)).toMatch(/\.bold-rj-actions button,[\s\S]*height: 44px/)
  expect(phone(list)).toMatch(/\.bold-tb-chips button[\s\S]*min-height: 44px/)
  expect(phone(tabs)).toMatch(/min-height: 44px/)
  expect(phone(panel)).toMatch(/height: 100dvh/)
  expect(phone(panel)).toMatch(/min-height: 44px/)
})

test('results into an agent’s direct chat read "{agent} (direct)"', async () => {
  state.jobs = [
    job('d1', 'builder', { deliverTo: { roomId: 'direct-builder', roomName: 'builder' } }),
  ]
  mount()
  expect(await screen.findByText('builder (direct)')).toBeTruthy()
})

test('the first job on an empty list opens its panel on a wide page', async () => {
  state.wide = true
  mount()
  await screen.findByText(/No repeating jobs yet/)
  fireEvent.click(screen.getByRole('button', { name: 'New repeating job' }))
  const panel = await screen.findByRole('complementary', { name: 'New repeating job' })
  expect(within(panel).getByRole('button', { name: 'Save' })).toBeTruthy()
  fireEvent.click(within(panel).getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('complementary')).toBeNull()
})

test('rows say whether the model follows the agent or is pinned', async () => {
  state.jobs = [
    job('f1', 'builder', { title: 'First follower' }),
    job('f2', 'builder', { title: 'Second follower' }),
    job('p1', 'builder', { title: 'Pinned one', model: 'deep' }),
  ]
  mount()
  const table = await screen.findByRole('table')
  expect(await within(table).findAllByText('its own · demo-model')).toHaveLength(2)
  const rows = within(table).getAllByRole('row')
  expect(within(rows[1]!).getByText('its own · demo-model')).toBeTruthy()
  expect(within(rows[2]!).getByText('its own · demo-model')).toBeTruthy()
  expect(within(rows[3]!).getByText('deep · pinned')).toBeTruthy()
})
