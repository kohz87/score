import { describe, expect, test } from 'vitest'
import * as contract from '../src/index.ts'
import * as f from './fixtures.ts'
import { nowTaskCases } from './schemas-cases-now-tasks.ts'

describe.each(nowTaskCases)('%s', (name, valid, invalid) => {
  const schema = contract[name]
  test('round-trips a valid JSON fixture', () => {
    expect(schema.parse(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
  })
  test('rejects an invalid fixture', () => {
    expect(schema.safeParse(invalid).success).toBe(false)
  })
})

test('a stored lane block without a kind reads as a task; chat bands carry a count', () => {
  const stored: Record<string, unknown> = { ...f.lane }
  delete stored.kind
  expect(contract.LaneBlockSchema.parse(stored).kind).toBe('task')
  expect(contract.LaneBlockSchema.parse({ ...f.lane, kind: 'chat', count: 3 }).count).toBe(3)
  expect(contract.LaneBlockSchema.safeParse({ ...f.lane, kind: 'chat', count: 0 }).success).toBe(
    false,
  )
  expect(contract.LaneBlockSchema.safeParse({ ...f.lane, kind: 'other' }).success).toBe(false)
})

describe('Kanban attempts (5.17a-1) additions', () => {
  test('an unattributed, partial attempt from an earlier board parses; tools stay null', () => {
    const parsed = contract.AttemptSummarySchema.parse(f.unattributedAttempt)
    expect(parsed.agentId).toBeNull()
    expect(parsed.task.current).toBe(false)
    expect(
      contract.AttemptSummarySchema.safeParse({ ...f.unattributedAttempt, id: 'run-1' }).success,
    ).toBe(false)
    expect(contract.AttemptSummarySchema.safeParse({ ...f.attempt, model: 'x' }).success).toBe(
      false,
    )
  })
  test('WorkItem is a tagged union of runs and attempts', () => {
    expect(contract.WorkItemSchema.safeParse({ kind: 'run', run: f.run }).success).toBe(true)
    expect(contract.WorkItemSchema.safeParse({ kind: 'run', attempt: f.attempt }).success).toBe(
      false,
    )
  })
  test('attempt lane blocks carry provenance, order and the observation boundary', () => {
    expect(contract.LaneBlockSchema.parse(f.attemptLane).order).toEqual([f.at, 41])
    expect(
      contract.LaneBlockSchema.safeParse({ ...f.attemptLane, provenance: 'guess' }).success,
    ).toBe(false)
    // Blocks of runs carry none of them: today's responses are unchanged.
    expect(contract.LaneBlockSchema.parse(f.lane).provenance).toBeUndefined()
  })
  test('a hand-off may start or end in the Unattributed lane', () => {
    expect(contract.HandoffSchema.parse(f.unattributedHandoff).from.agentId).toBeNull()
    expect(
      contract.HandoffSchema.safeParse({ ...f.unattributedHandoff, from: { blockId: 'x' } })
        .success,
    ).toBe(false)
  })
  test('history rows, task details and reports accept the attempt fields', () => {
    const item = {
      runId: f.attempt.id,
      title: 'T',
      origin: 'kanban',
      outcome: 'completed',
      startedAt: f.at,
      durationSec: 1,
      model: null,
      costUsd: null,
      task: null,
      brief: null,
      replaySeq: null,
      attempt: f.attempt,
    }
    expect(contract.AgentHistoryItemSchema.parse(item).attempt?.kind).toBe('kanban')
    expect(
      contract.AgentHistoryItemSchema.safeParse({ ...item, attempt: { ...f.attempt, kind: 'run' } })
        .success,
    ).toBe(false)
    const detail = {
      ...f.detail,
      unresolvedRunLinks: [{ legacyId: '12', reason: 'no_affirmative_evidence' }],
    }
    expect(contract.TaskDetailSchema.parse(detail).unresolvedRunLinks).toHaveLength(1)
    expect(
      contract.TaskDetailSchema.safeParse({ ...f.detail, unresolvedRunLinks: [{ legacyId: '' }] })
        .success,
    ).toBe(false)
  })
})
