import { StreamEventSchema, type StreamEvent } from '@score/contract'
import { expect, test, vi } from 'vitest'
import {
  createIngest,
  type DeepReadonly,
  type DomainEventDraft,
  type Observation,
} from '../../src/hub/index.ts'
import {
  draft,
  now,
  observation,
  persistedEvents,
  rows,
  setupIngestTest,
  type IngestTestState,
} from './ingest-helpers.ts'

let db: IngestTestState['db']
let ingest: IngestTestState['ingest']
let expectListenerErrors = false
let listenerLog: IngestTestState['listenerLog']
const testState: IngestTestState = {
  get db() {
    return db
  },
  set db(value) {
    db = value
  },
  get ingest() {
    return ingest
  },
  set ingest(value) {
    ingest = value
  },
  get expectListenerErrors() {
    return expectListenerErrors
  },
  set expectListenerErrors(value) {
    expectListenerErrors = value
  },
  get listenerLog() {
    return listenerLog
  },
  set listenerLog(value) {
    listenerLog = value
  },
}
setupIngestTest(testState)

test('one transaction commits projection, validated envelopes, first seq and checkpoint', async () => {
  const apply = vi.fn((ctx: Parameters<Observation['apply']>[0]) => {
    expect(ctx.sqlite.isTransaction).toBe(true)
    expect(ctx.now).toBe(now)
    observation('one').apply(ctx)
    return [draft('one'), draft('two')]
  })
  expect(await ingest.submit(observation('one', { apply }))).toEqual({
    status: 'applied',
    seqs: [1, 2],
  })
  expect(apply).toHaveBeenCalledOnce()
  expect(rows('test_runs')).toEqual([{ id: 'one', state: 'queued', updated_at: now }])
  expect(persistedEvents()).toEqual([
    { ...draft('one'), seq: 1, ts: now },
    { ...draft('two'), seq: 2, ts: now },
  ])
  expect(rows('ingest_keys')).toEqual([
    {
      source: 'score',
      identity: 'one',
      first_seq: 1,
      created_at: now,
      scope: 'runs',
      incarnation: 'incarnation-1',
      position: 1,
    },
  ])
  expect(rows('ingest_checkpoints')).toEqual([
    {
      source: 'score',
      scope: 'runs',
      cursor: '1',
      incarnation: 'incarnation-1',
      updated_at: now,
    },
  ])
})

test('normalized event JSON matches live delivery and the parsed replay envelope', async () => {
  const delivered: DeepReadonly<StreamEvent>[] = []
  ingest.onCommitted((events) => {
    delivered.push(...events)
  })
  const event = {
    type: 'message.completed' as const,
    data: { messageId: 'one', roomId: 'room', extra: 'discard this field' },
  }
  await ingest.submit(observation('one', { apply: () => [event] }))
  const stored = rows('events')[0]
  expect(stored).toBeDefined()
  const data: unknown = JSON.parse(String(stored?.data))
  expect(data).toEqual({ messageId: 'one', roomId: 'room' })
  expect(data).not.toHaveProperty('extra')
  expect(data).toEqual(delivered[0]?.data)
  const replay = StreamEventSchema.parse({ ...stored, data })
  expect(replay).toEqual(delivered[0])
  expect(delivered).toEqual([{ seq: 1, ts: now, type: event.type, data }])
})

test('duplicates skip apply and fan-out but advance the checkpoint without changing the ingest key', async () => {
  const listener = vi.fn()
  ingest.onCommitted(listener)
  await ingest.submit(observation('one'))
  const before = rows('ingest_keys')
  const apply = vi.fn(() => {
    throw new Error('Duplicate must never apply')
  })
  expect(
    await ingest.submit(
      observation('one', {
        apply,
        checkpoint: { scope: 'runs', position: 2, incarnation: null, resetIncarnation: true },
      }),
    ),
  ).toEqual({ status: 'duplicate' })
  expect(apply).not.toHaveBeenCalled()
  expect(listener).toHaveBeenCalledOnce()
  expect(rows('test_runs')).toEqual([{ id: 'one', state: 'queued', updated_at: now }])
  expect(persistedEvents()).toHaveLength(1)
  expect(rows('ingest_keys')).toEqual(before)
  expect(rows('ingest_checkpoints')).toEqual([
    { source: 'score', scope: 'runs', cursor: '2', incarnation: null, updated_at: now },
  ])
})

test('dedupe is durable across ingest instances and source identities are independent', async () => {
  await ingest.submit(observation('one'))
  await ingest.close()
  ingest = createIngest(db)
  const restarted = ingest
  expect(await restarted.submit(observation('one'))).toEqual({ status: 'duplicate' })
  expect(
    await restarted.submit(observation('one', { source: 'kanban', apply: () => [draft('other')] })),
  ).toEqual({ status: 'applied', seqs: [2] })
  expect(rows('ingest_keys')).toHaveLength(2)
})

test('zero-event observations commit projection and checkpoint with a NULL first_seq and no fan-out', async () => {
  const listener = vi.fn()
  ingest.onCommitted(listener)
  expect(
    await ingest.submit(
      observation('one', {
        apply(ctx) {
          observation('one').apply(ctx)
          return []
        },
      }),
    ),
  ).toEqual({
    status: 'applied',
    seqs: [],
  })
  expect(rows('ingest_keys')).toEqual([
    {
      source: 'score',
      identity: 'one',
      first_seq: null,
      created_at: now,
      scope: 'runs',
      incarnation: 'incarnation-1',
      position: 1,
    },
  ])
  expect(rows('ingest_checkpoints')).toHaveLength(1)
  expect(persistedEvents()).toEqual([])
  expect(listener).not.toHaveBeenCalled()
  expect(await ingest.submit(observation('one'))).toEqual({ status: 'duplicate' })
  expect(rows('test_runs')).toEqual([{ id: 'one', state: 'queued', updated_at: now }])
})

test('checkpoint scopes and sources are independent, and omitting a checkpoint leaves them untouched', async () => {
  await ingest.submit(observation('one'))
  await ingest.submit(
    observation('two', { checkpoint: { scope: 'messages', position: 2, incarnation: null } }),
  )
  await ingest.submit(observation('three', { source: 'kanban' }))
  const checkpoints = rows('ingest_checkpoints')
  expect(checkpoints).toHaveLength(3)
  await ingest.submit(observation('four', { checkpoint: undefined }))
  expect(rows('ingest_checkpoints')).toEqual(checkpoints)
  await ingest.submit(observation('one', { checkpoint: undefined }))
  expect(rows('ingest_checkpoints')).toEqual(checkpoints)
})

test.each(['apply throws', 'invalid second event', 'async apply', 'invalid checkpoint write'])(
  '%s rolls back projection, every event, ingest key and checkpoint; a retry can apply',
  async (failure) => {
    const listener = vi.fn()
    ingest.onCommitted(listener)
    let obs = observation('broken', {
      apply(ctx) {
        observation('broken').apply(ctx)
        if (failure === 'apply throws') throw new Error('abort')
        if (failure === 'async apply') {
          // Exercise an untyped producer violating the synchronous API.
          return Promise.resolve([]) as unknown as DomainEventDraft[]
        }
        if (failure === 'invalid second event') {
          return [
            draft('valid'),
            { type: 'message.completed', data: { messageId: '', roomId: 'room' } },
          ]
        }
        ctx.sqlite.exec(`CREATE TRIGGER reject_checkpoint BEFORE INSERT ON ingest_checkpoints
          BEGIN SELECT RAISE(ABORT, 'checkpoint failed'); END`)
        return [draft('valid')]
      },
    })
    await expect(ingest.submit(obs)).rejects.toThrow()
    for (const table of ['test_runs', 'events', 'ingest_keys', 'ingest_checkpoints']) {
      expect(rows(table)).toEqual([])
    }
    expect(listener).not.toHaveBeenCalled()
    expect(db.sqlite.isTransaction).toBe(false)
    obs = observation('broken')
    expect(await ingest.submit(obs)).toEqual({ status: 'applied', seqs: [1] })
  },
)

test('failed projection update preserves existing projection and checkpoint', async () => {
  await ingest.submit(observation('one'))
  const before = {
    projection: rows('test_runs'),
    events: rows('events'),
    keys: rows('ingest_keys'),
    checkpoints: rows('ingest_checkpoints'),
  }
  await expect(
    ingest.submit(
      observation('two', {
        apply({ sqlite }) {
          sqlite.exec("UPDATE test_runs SET state = 'completed'")
          throw new Error('abort update')
        },
      }),
    ),
  ).rejects.toThrow('abort update')
  expect(rows('test_runs')).toEqual(before.projection)
  expect(rows('events')).toEqual(before.events)
  expect(rows('ingest_keys')).toEqual(before.keys)
  expect(rows('ingest_checkpoints')).toEqual(before.checkpoints)
})
