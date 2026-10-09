import { expect, test } from 'vitest'
import { classify, type ClassifyInput } from '../../../src/hermes/live/kanban-attempts/classify.ts'
import {
  effectiveMark,
  judgeHistory,
  tupleContradiction,
  type JudgeInput,
  type KnownAttempt,
} from '../../../src/hermes/live/kanban-attempts/history-policy.ts'
import { attemptStatus } from '../../../src/hermes/live/kanban-attempts/project.ts'
import type {
  HermesAttempt,
  HermesEvidenceEvent,
  Marks,
} from '../../../src/hermes/live/kanban-attempts/types.ts'

const row = (overrides: Partial<HermesAttempt> = {}): HermesAttempt => ({
  id: 7,
  task_id: 't1',
  profile: 'builder',
  status: 'running',
  claim_lock: null,
  worker_pid: null,
  worker_started_at: null,
  started_at: 1000,
  ended_at: null,
  outcome: null,
  summary: null,
  error: null,
  ...overrides,
})
const marks = (overrides: Partial<Marks> = {}): Marks => ({
  eventSeq: 10,
  runSeq: 5,
  eventMin: 1,
  eventMax: 10,
  runMin: 1,
  runMax: 5,
  ...overrides,
})
const known = (overrides: Partial<KnownAttempt> = {}): KnownAttempt => ({
  attemptId: 7,
  taskId: 't1',
  startedAt: 1000,
  closed: false,
  claimLock: null,
  profile: null,
  workerPid: null,
  workerStartedAt: null,
  ...overrides,
})
const judge = (overrides: Partial<JudgeInput> = {}) =>
  judgeHistory({
    saved: { eventMark: 10, attemptMark: 5, fileIdentity: 'a' },
    observedIdentity: 'a',
    marks: marks(),
    rows: [],
    sample: [],
    known: new Map(),
    knownCount: 0,
    sampleIds: [],
    ...overrides,
  })

test('allocation marks: missing row is valid only for an empty table', () => {
  expect(effectiveMark('task_runs', null, null, null)).toEqual({ mark: 0 })
  expect(effectiveMark('task_runs', null, 1, 3)).toHaveProperty('insufficient')
  expect(effectiveMark('task_runs', 2, 1, 3)).toHaveProperty('insufficient')
  expect(effectiveMark('task_runs', 9, null, null)).toEqual({ mark: 9 })
})

test('retained maxima falling (GC, deletion) is normal maintenance; a mark below the saved mark is not', () => {
  expect(judge({ marks: marks({ eventMin: 8, eventMax: 10 }) }).verdict).toBe('ok')
  expect(judge({ marks: marks({ eventSeq: 9, eventMax: 9 }) })).toMatchObject({
    verdict: 'contradiction',
  })
  expect(judge({ marks: marks({ runSeq: 4, runMax: 4 }) })).toMatchObject({
    verdict: 'contradiction',
  })
})

test('an unreadable or inconsistent sequence is insufficient evidence, not a contradiction', () => {
  expect(judge({ marks: null }).verdict).toBe('insufficient')
  expect(judge({ marks: marks({ eventSeq: null }) }).verdict).toBe('insufficient')
})

test('frozen evidence is compared non-null to non-null only', () => {
  const frozen = known({
    claimLock: 'host:1',
    profile: 'builder',
    workerPid: 4,
    workerStartedAt: 'b|4',
  })
  // Cleared by invariant recovery or the reaper: not a contradiction.
  expect(
    tupleContradiction(
      frozen,
      row({ claim_lock: null, worker_pid: null, worker_started_at: null }),
    ),
  ).toBeNull()
  // Enrichment unknown -> known: not a contradiction.
  expect(tupleContradiction(known(), row({ claim_lock: 'host:9', worker_pid: 9 }))).toBeNull()
  // A different non-null value is.
  expect(tupleContradiction(frozen, row({ claim_lock: 'host:2' }))).toMatch(/claim lock/)
  expect(tupleContradiction(frozen, row({ profile: 'reviewer' }))).toMatch(/profile/)
  expect(tupleContradiction(frozen, row({ worker_pid: 5 }))).toMatch(/pid/)
  expect(tupleContradiction(frozen, row({ worker_started_at: 'b|5' }))).toMatch(/fingerprint/)
  expect(tupleContradiction(known(), row({ started_at: 1001 }))).toMatch(/start time/)
  expect(tupleContradiction(known(), row({ task_id: 't2' }))).toMatch(/another task/)
  expect(tupleContradiction(known({ closed: true }), row())).toMatch(/open again/)
})

test('a changed file identity needs a sample that can decide', () => {
  const changed = { observedIdentity: 'b', knownCount: 3, sampleIds: [7] }
  expect(judge({ ...changed, sample: [row()], known: new Map([[7, known()]]) }).verdict).toBe('ok')
  expect(judge({ ...changed, sample: [] }).verdict).toBe('insufficient')
  expect(
    judge({ ...changed, sample: [row({ started_at: 5 })], known: new Map([[7, known()]]) }).verdict,
  ).toBe('contradiction')
  // Nothing known yet: nothing to contradict.
  expect(judge({ observedIdentity: 'b', knownCount: 0, sampleIds: [] }).verdict).toBe('ok')
})

test('outcome and status mapping never guesses', () => {
  expect(attemptStatus(row())).toEqual({ status: 'running', closureReason: null })
  const closed = (outcome: string | null, status = 'x') =>
    attemptStatus(row({ ended_at: 1001, outcome, status }))
  expect(closed('completed')).toEqual({ status: 'completed', closureReason: 'completed' })
  expect(closed('review_requested').status).toBe('review_handoff')
  expect(closed('changes_requested').status).toBe('changes_requested')
  expect(closed('crashed').status).toBe('failed')
  expect(closed('reclaimed').status).toBe('ended_unknown')
  expect(closed('brand_new_outcome')).toEqual({ status: 'ended_unknown', closureReason: 'other' })
  expect(closed(null, 'done')).toEqual({ status: 'completed', closureReason: 'unknown' })
  expect(closed(null, 'weird')).toEqual({ status: 'ended_unknown', closureReason: 'unknown' })
})

const event = (overrides: Partial<HermesEvidenceEvent>): HermesEvidenceEvent => ({
  id: 1,
  task_id: 't1',
  run_id: null,
  kind: 'created',
  payload: null,
  created_at: 900,
  ...overrides,
})
const synthetic = (overrides: Partial<ClassifyInput> = {}): ClassifyInput => ({
  row: row({ started_at: 1000, ended_at: 1000, outcome: 'blocked', status: 'blocked' }),
  stored: null,
  events: [event({ id: 1 }), event({ id: 2, kind: 'blocked', run_id: 7 })],
  eventsTruncated: false,
  task: { id: 't1', title: 'x', status: 'blocked', assignee: 'builder', started_at: null },
  ...overrides,
})

test('synthetic only where the evidence distinguishes the synthetic writer', () => {
  expect(classify(synthetic())).toEqual({ evidence: 'synthetic', basis: 'synthetic_transition' })
  const partial = (input: ClassifyInput, basis: string) =>
    expect(classify(input)).toEqual({ evidence: 'partial', basis })
  partial(
    synthetic({ events: [event({ id: 2, kind: 'blocked', run_id: 7 })] }),
    'history_not_retained',
  )
  partial(
    synthetic({
      events: [
        event({ id: 1 }),
        event({ id: 3, kind: 'claimed', run_id: 3 }),
        event({ id: 4, kind: 'blocked', run_id: 7 }),
      ],
    }),
    'claim_precedes_row',
  )
  partial(
    synthetic({
      task: { id: 't1', title: 'x', status: 'blocked', assignee: null, started_at: 1000 },
    }),
    'task_started_before_row',
  )
  partial(synthetic({ task: undefined }), 'task_missing')
  partial(synthetic({ eventsTruncated: true }), 'events_truncated')
  partial(
    synthetic({ row: row({ started_at: 1000, ended_at: 1001, outcome: 'blocked' }) }),
    'closed_not_synthetic_shape',
  )
  partial(
    synthetic({ row: row({ started_at: 1000, ended_at: 1000, outcome: 'crashed' }) }),
    'closed_outcome_not_synthesized',
  )
})

test('positive evidence wins and a row ever seen open is never reclassified synthetic', () => {
  expect(
    classify(
      synthetic({
        row: row({ started_at: 1, ended_at: 1, outcome: 'blocked', claim_lock: 'h:1' }),
      }),
    ),
  ).toEqual({ evidence: 'proven', basis: 'claim_lock' })
  const stored = {
    evidence: 'partial' as const,
    firstSeenOpen: true,
    claimLock: null,
    claimEventId: null,
    workerPid: null,
    workerStartedAt: null,
  }
  expect(classify(synthetic({ stored }))).toEqual({ evidence: 'partial', basis: 'seen_open' })
  // Frozen evidence survives a cleanup of the live field.
  expect(classify(synthetic({ stored: { ...stored, claimLock: 'host:1' } })).evidence).toBe(
    'proven',
  )
  expect(classify({ ...synthetic(), row: row(), events: [] }).basis).toBe('open_without_evidence')
})
