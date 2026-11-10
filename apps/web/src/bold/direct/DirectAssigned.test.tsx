import { screen } from '@testing-library/react'
import type { AgentAssigned, TaskSummary } from '@score/contract'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  assignedFixture,
  inHours,
  repeatingJob,
  snapshot,
  task,
} from '../assigned/assigned-test-data.ts'
import { openAllInfoSections, resetInfoFolds } from '../chats/info-test-utils.ts'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  mockFetch,
  renderInRoom,
} from '../room/room-test-utils.tsx'
import { DirectAssigned } from './DirectAssigned.tsx'

beforeEach(openAllInfoSections)

afterEach(() => {
  resetInfoFolds()
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const builder = agents[1]!

function stub(assigned: AgentAssigned, tasks: TaskSummary[] = []) {
  vi.stubGlobal(
    'fetch',
    mockFetch((url) => {
      if (url === `/api/agents/${builder.id}/assigned`) return jsonResponse(assigned)
      if (url === '/api/tasks') return jsonResponse(snapshot(tasks))
      return jsonResponse({ asOfSeq: 0, items: [] })
    }),
  )
}

function renderAssigned(onNavigate?: () => void) {
  return renderInRoom(<DirectAssigned agent={builder} onNavigate={onNavigate} />, [
    '/b?with=builder',
  ])
}

test('each kind of assignment is a link into Tasks, with its schedule in words or as stored', async () => {
  stub(
    assignedFixture({
      repeating: [
        repeatingJob({
          id: 'r1',
          title: 'Morning summary',
          schedule: '0 8 * * *',
          nextRunAt: inHours(14),
        }),
      ],
      recipeSteps: [
        {
          workflowId: 'wf-1',
          recipeName: 'Release notes',
          stepLabel: 'Draft',
          schedule: '0 16 * * 5',
        },
      ],
    }),
    [
      task({ id: 't1', title: 'Fix the feed cursor', column: 'working' }),
      task({ id: 't2', title: 'Paginate the feed', column: 'planned' }),
    ],
  )
  renderAssigned()
  const job = await screen.findByRole('link', { name: /^Morning summary/ })
  expect(job.textContent).toBe('Morning summary · 0 8 * * * · next in 14 h')
  expect(job.getAttribute('href')).toBe('/b/tasks/repeating?agent=builder')
  const step = screen.getByRole('link', { name: /^Release notes/ })
  expect(step.textContent).toBe('Release notes (Draft) · recipe step · 0 16 * * 5')
  expect(step.getAttribute('href')).toBe('/b/tasks/recipes/wf-1')
  const working = screen.getByRole('link', { name: 'Fix the feed cursor · task · in progress' })
  expect(working.getAttribute('href')).toBe('/b/tasks')
  expect(screen.getByRole('link', { name: 'Paginate the feed · task · to do' })).toBeDefined()
  expect(screen.getByRole('link', { name: 'All in Tasks' }).getAttribute('href')).toBe('/b/tasks')
  expect(screen.getByText('Read here, set in Tasks.')).toBeDefined()
})

test('a recipe step with no schedule says only that it is a recipe step', async () => {
  stub(
    assignedFixture({
      recipeSteps: [
        { workflowId: 'wf-2', recipeName: 'Hand-off', stepLabel: 'Review', schedule: null },
      ],
    }),
  )
  renderAssigned()
  expect(await screen.findByRole('link', { name: 'Hand-off (Review) · recipe step' })).toBeDefined()
})

test('nothing assigned says so, and the Tasks link stays', async () => {
  stub(assignedFixture())
  renderAssigned()
  expect(await screen.findByText('Nothing assigned.')).toBeDefined()
  expect(screen.getByRole('link', { name: 'All in Tasks' })).toBeDefined()
})

test('following a link leaves the sheet', async () => {
  stub(assignedFixture({ repeating: [repeatingJob({ id: 'r1', title: 'Morning summary' })] }))
  const onNavigate = vi.fn()
  renderAssigned(onNavigate)
  const job = await screen.findByRole('link', { name: /^Morning summary/ })
  job.click()
  expect(onNavigate).toHaveBeenCalledTimes(1)
})
