import { screen } from '@testing-library/react'
import type { AgentAssigned, TaskSummary } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import { assignedFixture, repeatingJob, snapshot, task } from '../assigned/assigned-test-data.ts'
import { agent } from '../agent-more/agent-more-helpers.tsx'
import { disposeRoomTest, jsonResponse, mockFetch, renderInRoom } from '../room/room-test-utils.tsx'
import { AssignedTile } from './AssignedTile.tsx'

afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

/** The agent's assigned work and the board's tasks, as the two reads answer them. */
function stub(assigned: AgentAssigned | 'error', tasks: TaskSummary[] = []) {
  vi.stubGlobal(
    'fetch',
    mockFetch((url) => {
      if (url === `/api/agents/${agent.id}/assigned`)
        return assigned === 'error'
          ? jsonResponse({ message: 'boom' }, 500)
          : jsonResponse(assigned)
      if (url === '/api/tasks') return jsonResponse(snapshot(tasks))
      return jsonResponse({ asOfSeq: 0, items: [] })
    }),
  )
}

function renderTile() {
  return renderInRoom(<AssignedTile agent={agent} />, ['/b/agents/builder'])
}

test('nothing assigned says so, with the counts at zero', async () => {
  stub(assignedFixture())
  renderTile()
  expect(
    await screen.findByRole('heading', { name: 'Assigned · 0 repeating, 0 tasks', level: 3 }),
  ).toBeDefined()
  expect(screen.getByText('Nothing assigned.')).toBeDefined()
})

test('repeating jobs and recipe steps are listed by name and counted together', async () => {
  stub(
    assignedFixture({
      repeating: [
        repeatingJob({ id: 'r1', title: 'Morning summary' }),
        repeatingJob({ id: 'r2', title: 'Dependency check', schedule: '0 9 * * 1' }),
      ],
      recipeSteps: [
        { workflowId: 'wf-1', recipeName: 'Release notes', stepLabel: 'Draft', schedule: null },
      ],
    }),
  )
  renderTile()
  expect(
    await screen.findByRole('heading', { name: 'Assigned · 3 repeating, 0 tasks', level: 3 }),
  ).toBeDefined()
  expect(
    screen.getByText('Morning summary · Dependency check · Release notes (Draft)'),
  ).toBeDefined()
})

test('open tasks count, done ones and other agents’ do not', async () => {
  stub(assignedFixture(), [
    task({ id: 't1', title: 'Fix the feed cursor', column: 'working' }),
    task({ id: 't2', title: 'Paginate the feed', column: 'planned' }),
    task({ id: 't3', title: 'Shipped', column: 'done' }),
    task({ id: 't4', title: 'Lead’s', column: 'working', assignee: 'lead' }),
  ])
  renderTile()
  expect(
    await screen.findByRole('heading', { name: 'Assigned · 0 repeating, 2 tasks', level: 3 }),
  ).toBeDefined()
})

test('Open in Tasks and Start a repeating job link into Tasks', async () => {
  stub(assignedFixture())
  renderTile()
  const open = await screen.findByRole('link', { name: 'Open in Tasks' })
  expect(open.getAttribute('href')).toBe('/b/tasks/repeating?agent=builder')
  expect(screen.getByRole('link', { name: 'Start a repeating job' }).getAttribute('href')).toBe(
    '/b/tasks/repeating?new=1&agent=builder',
  )
})

test('a failed read says it could not load, and does not invent counts', async () => {
  stub('error')
  renderTile()
  expect(await screen.findByText('Couldn’t load what’s assigned.')).toBeDefined()
  expect(screen.queryByRole('link', { name: 'Open in Tasks' })).toBeNull()
})
