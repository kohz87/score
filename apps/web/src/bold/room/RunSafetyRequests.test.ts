import type { NeedsYou, WorkflowNeedsYou } from '@score/contract'
import { expect, test } from 'vitest'
import { orchestrationNeedEntries, workflowNeedEntries } from './RunSafetyRequests.tsx'

test('an unconfirmed attempt and its cancel fence are one card with both ways on', () => {
  const needs: NeedsYou[] = [
    { kind: 'unknown', attemptId: 'a1' },
    { kind: 'cancel_fence', stepId: 's1', attemptId: 'a1' },
    {
      kind: 'quota_low',
      stepId: 's2',
      agentId: 'builder',
      window: '5 hours',
      group: null,
      leftPercent: 10,
      resetsAt: '2026-10-24T10:30:00.000Z',
    },
  ]
  expect(orchestrationNeedEntries({ needsYou: needs })).toMatchObject([
    { key: 'unknown-a1', item: { kind: 'unknown' }, fenceStepId: 's1' },
    { key: 'quota_low-s2', item: { kind: 'quota_low' } },
  ])
})

test('a stopped workflow keeps only the work that is still winding down', () => {
  const needs: WorkflowNeedsYou[] = [
    { kind: 'retry', nodeId: 'review', attemptsLeft: 1 },
    { kind: 'unknown', attemptId: 'a1', nodeId: 'review' },
    { kind: 'fence', reason: 'restore' },
  ]
  expect(workflowNeedEntries({ needsYou: needs, status: 'stopped' })).toMatchObject([
    { key: 'unknown-a1', item: { kind: 'unknown' } },
    { key: 'fence-restore', item: { kind: 'fence' } },
  ])
})

test('a running workflow lists every need, including a separate cancel fence', () => {
  const needs: WorkflowNeedsYou[] = [
    { kind: 'cancel_fence', stepId: 's1', attemptId: 'a1' },
    {
      kind: 'remap',
      agentId: 'reviewer',
      frozenIncarnation: 'old',
      currentIncarnation: 'new',
      nodeIds: ['review'],
      plan: [],
    },
  ]
  expect(workflowNeedEntries({ needsYou: needs, status: 'running' })).toMatchObject([
    { key: 'cancel_fence-s1' },
    { key: 'remap-reviewer' },
  ])
})
