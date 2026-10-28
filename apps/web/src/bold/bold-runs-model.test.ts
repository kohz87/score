import { expect, test } from 'vitest'
import { orchestrationSnapshot } from '../../../../e2e/orchestration-fixtures.ts'
import { runSnapshot } from '../../../../e2e/workflow-fixtures.ts'
import { filterRuns, orchestrationThread, runRows, workflowThread } from './bold-runs-model.ts'

test('the thread of an orchestration starts with the lead and has one entry per step', () => {
  const run = orchestrationSnapshot.orchestration
  const thread = orchestrationThread(run)
  expect(thread[0]?.kind).toBe('lead')
  expect(thread.filter((step) => step.kind === 'agent').length).toBe(run.stepsList.length)
  expect(thread.map((step) => step.n)).toEqual(thread.map((_, index) => index + 1))
})

test('the thread of a workflow run has one entry per node', () => {
  const run = runSnapshot.run
  expect(workflowThread(run).length).toBe(run.definition.nodes.length)
})

test('rows are newest first and the filters pick needs-you, running and done', () => {
  const orch = orchestrationSnapshot.orchestration
  const wf = runSnapshot.run
  const rows = runRows([orch], [wf])
  expect(rows.length).toBe(2)
  expect(rows[0]!.createdAt >= rows[1]!.createdAt).toBe(true)
  expect(filterRuns(rows, 'needs').every((row) => row.needs > 0)).toBe(true)
  expect(filterRuns(rows, 'running').length + filterRuns(rows, 'done').length).toBe(2)
})

test('advisor steps are not in the lead thread (3.14)', () => {
  const run = orchestrationSnapshot.orchestration
  const first = run.stepsList[0]!
  const withAdvisor = {
    ...run,
    stepsList: [...run.stepsList, { ...first, id: 'advisor-step', role: 'advisor' as const }],
  }
  const thread = orchestrationThread(withAdvisor)
  expect(thread.some((step) => step.id === 'advisor-step')).toBe(false)
  expect(thread.filter((step) => step.kind === 'agent').length).toBe(run.stepsList.length)
})

test('each advisor consult is its own entry with the advice, and is not counted as a step (3.14)', () => {
  const run = orchestrationSnapshot.orchestration
  const first = run.stepsList[0]!
  const withAdvisor = {
    ...run,
    stepsList: [
      ...run.stepsList,
      { ...first, id: 'advisor-step', role: 'advisor' as const, status: 'succeeded' as const },
    ],
    advisor: {
      agentId: 'reviewer',
      consults: [
        {
          stepId: 'advisor-step',
          checkpoint: 'before_plan' as const,
          reason: '',
          status: 'succeeded' as const,
          advice: 'Split it in two.',
          createdAt: '2000-01-01T00:00:00.000Z',
        },
      ],
    },
  }
  const thread = orchestrationThread(withAdvisor)
  const entry = thread.find((step) => step.kind === 'advisor')!
  expect(entry.title).toBe('Advisor · before the plan')
  expect(entry.reply).toBe('Split it in two.')
  expect(entry.agentId).toBe('reviewer')
  expect(thread.filter((step) => step.kind === 'agent').length).toBe(run.stepsList.length)
  expect(thread.map((step) => step.n)).toEqual(thread.map((_, index) => index + 1))
})
