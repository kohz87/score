import { cleanup, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { WorkflowRunLive } from './WorkflowRunLive.tsx'
import { revisionOf, setUpWorkflowTests, started } from './workflows-test-helpers.tsx'

const { state, mount } = setUpWorkflowTests()

test('a finished run says both what the executor did and what the graph did', async () => {
  state.snapshot = revisionOf((run) => {
    Object.assign(run, {
      status: 'finished_with_unresolved',
      graphOutcome: 'reached_end',
      outcomeNote: 'Workflow reached its end — 1 step run not confirmed as ended',
      needsYou: [],
      endedAt: '2026-10-10T10:00:00.000Z',
    })
  })
  mount(<WorkflowRunLive runId="wfrun-1" onStarted={started} />)
  await screen.findByRole('log', { name: 'Events' })
  expect(screen.getByText('Finished, not everything confirmed')).toBeTruthy()
  expect(screen.getAllByText('Workflow reached its end').length).toBeGreaterThan(0)
  expect(
    screen.getByText('Workflow reached its end — 1 step run not confirmed as ended'),
  ).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Replay this run' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Run again…' })).toBeTruthy()
})

test('3.29.0: the chat’s Graph tab says how a finished run ended (its graph outcome and note)', async () => {
  state.snapshot = revisionOf((run) => {
    Object.assign(run, {
      status: 'finished_with_unresolved',
      graphOutcome: 'reached_end',
      outcomeNote: 'Workflow reached its end — 1 step run not confirmed as ended',
      needsYou: [],
      endedAt: '2026-10-10T10:00:00.000Z',
    })
  })
  mount(<WorkflowRunLive runId="wfrun-1" onStarted={started} pane="graph" />)
  const note = await screen.findByText(
    'Workflow reached its end — 1 step run not confirmed as ended',
  )
  expect(note.className).toBe('wf-outcome-note')
  expect(note.closest('.wf-pane-outcome')).not.toBeNull()
  // The log pane doesn't repeat it.
  cleanup()
  mount(<WorkflowRunLive runId="wfrun-1" onStarted={started} pane="log" />)
  await screen.findByRole('log', { name: 'Events' })
  expect(document.querySelector('.wf-pane-outcome')).toBeNull()
})
