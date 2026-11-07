import type { ApprovalChoice } from '@score/contract'
import { expect, test, vi } from 'vitest'
import { scenarioDuration } from '../../src/hermes/fake/scenario.ts'
import {
  deliverDecisionTo,
  eventsFor,
  installFakeHooks,
  playScenario,
  type FakeState,
} from './fake-helpers.ts'

let directory: FakeState['directory']
let db: FakeState['db']
let ingest: FakeState['ingest']
let port: FakeState['port']
let scheduler: FakeState['scheduler']
let sink: FakeState['sink']
let observations: FakeState['observations']
let results: FakeState['results']
let onError: FakeState['onError']

installFakeHooks(
  (state) => {
    directory = state.directory
    db = state.db
    ingest = state.ingest
    port = state.port
    scheduler = state.scheduler
    sink = state.sink
    observations = state.observations
    results = state.results
    onError = state.onError
  },
  () => ({ directory, db, ingest, port, scheduler, sink, observations, results, onError }),
)

const events = () => eventsFor(db)
const play = () => playScenario(port, sink, scheduler, ingest)
const deliverDecision = (req: { approvalId: string; choice: ApprovalChoice }) =>
  deliverDecisionTo(port, req)

test.each(['score-run', 'gateway'] as const)(
  'delivers a pending %s decision exactly once, even concurrently',
  async (origin) => {
    await port.start(sink)
    await scheduler.advance(2600 * 18)
    const req = { approvalId: `approval-${origin}-0`, choice: 'once' as const }
    expect(await Promise.all([deliverDecision(req), deliverDecision(req)])).toEqual([
      'applied',
      'not_pending',
    ])
    const update = events().at(-1)
    expect(update?.type).toBe('approval.updated')
    expect(update?.data).toMatchObject({
      id: req.approvalId,
      phase: 'decided',
      status: 'approved',
      decision: { choice: 'once', by: 'elsewhere', at: new Date(scheduler.now()).toISOString() },
      delivery: 'none',
    })
    await scheduler.advance(scenarioDuration)
    expect(
      events().filter(
        (event) => event.type === 'approval.updated' && event.data.id === req.approvalId,
      ),
    ).toHaveLength(1)
  },
)

test('unknown and decided approvals are not pending; direct port evidence carries no Score attribution', async () => {
  await play()
  const count = events().length
  expect(await deliverDecision({ approvalId: 'unknown', choice: 'deny' })).toBe('not_pending')
  expect(await deliverDecision({ approvalId: 'approval-score-run-0', choice: 'deny' })).toBe(
    'not_pending',
  )
  expect(events()).toHaveLength(count)
  expect(await deliverDecision({ approvalId: 'approval-gateway-0', choice: 'deny' })).toBe(
    'applied',
  )
  expect(events().at(-1)?.data).toMatchObject({
    status: 'denied',
    decision: { choice: 'deny', by: 'elsewhere' },
    delivery: 'none',
  })
  expect(await deliverDecision({ approvalId: 'approval-kanban-0', choice: 'session' })).toBe(
    'not_pending',
  )
})

test('a failed decision submission leaves the approval pending for retry', async () => {
  await play()
  const submit = vi.spyOn(sink, 'submit').mockRejectedValueOnce(new Error('ingest failure'))
  const req = { approvalId: 'approval-gateway-0', choice: 'once' as const }
  expect(await deliverDecision(req)).toBe('failed')
  expect(await deliverDecision(req)).toBe('applied')
  expect(submit).toHaveBeenCalledTimes(2)
})

test('Kanban denial is view-only and task actions preserve the Hermes state machine', async () => {
  await port.start(sink)
  await scheduler.advance(2600 * 18)
  const card = events().find(
    (event) => event.type === 'approval.requested' && event.data.origin === 'kanban',
  )
  expect(card?.data).toMatchObject({
    actionable: false,
    choices: [],
    refs: [{ kind: 'task', taskId: 'task-pagination-0' }],
  })
  expect(await deliverDecision({ approvalId: 'approval-kanban-0', choice: 'once' })).toBe(
    'not_pending',
  )
  await expect(port.taskAction({ taskId: 'missing', action: 'unblock' })).rejects.toMatchObject({
    status: 404,
  })
  await expect(
    port.taskAction({ taskId: 'task-pagination-0', action: 'comment', text: 'Denied' }),
  ).resolves.toEqual({ hermesStatus: 'blocked' })
  await expect(
    port.taskAction({ taskId: 'task-pagination-0', action: 'unblock', text: 'Try again' }),
  ).resolves.toEqual({ hermesStatus: 'ready' })
  expect(events().at(-1)?.data).toMatchObject({
    origin: 'kanban',
    phase: 'withdrawn',
    status: 'withdrawn',
  })
  await expect(
    port.taskAction({ taskId: 'task-pagination-0', action: 'unblock' }),
  ).rejects.toMatchObject({ status: 409, details: { hermesStatus: 'ready' } })
  await scheduler.advance(3700 * 18)
  await expect(
    port.taskAction({ taskId: 'task-pagination-0', action: 'comment', text: 'note' }),
  ).resolves.toEqual({ hermesStatus: 'ready' })
})
