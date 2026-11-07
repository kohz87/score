import { type StreamEvent } from '@score/contract'
import { expect, test, vi } from 'vitest'
import { headSeq, type DeepReadonly } from '../../src/hub/index.ts'
import {
  draft,
  observation,
  persistedEvents,
  rows,
  secondConnection,
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

test('queued submissions stay FIFO across rejection', async () => {
  const order: string[] = []
  ingest.onCommitted((events) => {
    order.push(`commit:${events[0]?.seq}`)
  })
  const submissions = ['one', 'broken', 'two', 'three'].map((id) =>
    ingest.submit(
      observation(id, {
        apply(ctx) {
          order.push(id)
          if (id === 'broken') throw new Error('abort')
          return observation(id).apply(ctx)
        },
      }),
    ),
  )
  const settled = Promise.allSettled(submissions)
  expect(order).toEqual([])
  await ingest.drain()
  expect(order).toEqual(['one', 'commit:1', 'broken', 'two', 'commit:2', 'three', 'commit:3'])
  expect((await settled).map((result) => result.status)).toEqual([
    'fulfilled',
    'rejected',
    'fulfilled',
    'fulfilled',
  ])
  expect(rows('test_runs').map((row) => row.id)).toEqual(['one', 'two', 'three'])
})

test('listeners see committed envelopes in sequence order through a separate connection', async () => {
  const reader = secondConnection()
  const captured: unknown[] = []
  const listener = vi.fn((events: DeepReadonly<StreamEvent[]>) => {
    captured.push({
      inTransaction: db.sqlite.isTransaction,
      projections: reader.prepare('SELECT id FROM test_runs').all(),
      seqs: reader.prepare('SELECT seq FROM events ORDER BY seq').all(),
      key: reader.prepare('SELECT first_seq FROM ingest_keys').get(),
      checkpoint: reader.prepare('SELECT cursor FROM ingest_checkpoints').get(),
      events,
    })
  })
  ingest.onCommitted(listener)
  await ingest.submit(
    observation('one', {
      apply(ctx) {
        observation('one').apply(ctx)
        return [draft('one'), draft('two')]
      },
    }),
  )
  await ingest.flushListeners()
  expect(listener).toHaveBeenCalledOnce()
  expect(captured).toEqual([
    {
      inTransaction: false,
      projections: [{ id: 'one' }],
      seqs: [{ seq: 1 }, { seq: 2 }],
      key: { first_seq: 1 },
      checkpoint: { cursor: '1' },
      events: persistedEvents(),
    },
  ])
  expect(listenerLog).not.toHaveBeenCalled()
})

test('throwing listeners are logged, other listeners run, and unsubscribing stops delivery', async () => {
  expectListenerErrors = true
  const log = listenerLog
  const failure = new Error('listener failed')
  const unsubscribe = ingest.onCommitted(() => {
    throw failure
  })
  const listener = vi.fn()
  ingest.onCommitted(listener)
  expect(await ingest.submit(observation('one'))).toEqual({ status: 'applied', seqs: [1] })
  await ingest.flushListeners()
  expect(log).toHaveBeenCalledExactlyOnceWith('Ingest committed listener failed', failure)
  expect(listener).toHaveBeenCalledOnce()
  unsubscribe()
  unsubscribe()
  await ingest.submit(observation('two'))
  await ingest.flushListeners()
  expect(log).toHaveBeenCalledOnce()
  expect(listener).toHaveBeenCalledTimes(2)
})

test('async listener failures are logged and pending listeners do not block the writer', async () => {
  expectListenerErrors = true
  const log = listenerLog
  const failure = new Error('async listener failed')
  ingest.onCommitted(async () => {
    throw failure
  })
  const { promise, resolve } = Promise.withResolvers<void>()
  ingest.onCommitted(() => promise)
  const listener = vi.fn()
  ingest.onCommitted(listener)
  const submitted = Promise.all([
    ingest.submit(observation('one')),
    ingest.submit(observation('two')),
  ])
  await ingest.drain()
  expect(await submitted).toEqual([
    { status: 'applied', seqs: [1] },
    { status: 'applied', seqs: [2] },
  ])
  resolve()
  await ingest.flushListeners()
  expect(log).toHaveBeenCalledTimes(2)
  expect(log).toHaveBeenCalledWith('Ingest committed listener failed', failure)
  expect(listener).toHaveBeenCalledTimes(2)
  resolve()
})

test('reentrant listener submissions stay behind already queued observations and drain waits for them', async () => {
  const results: Promise<unknown>[] = []
  ingest.onCommitted((events) => {
    if (events[0]?.seq === 1) results.push(ingest.submit(observation('three')))
  })
  results.push(ingest.submit(observation('one')), ingest.submit(observation('two')))
  await ingest.drain()
  await Promise.all(results)
  expect(rows('test_runs').map((row) => row.id)).toEqual(['one', 'two', 'three'])
  expect(persistedEvents().map((event) => event.seq)).toEqual([1, 2, 3])
})

test.each(['seq', 'data', 'batch'] as const)(
  'a listener mutating %s throws without altering later delivery, storage or the result',
  async (target) => {
    expectListenerErrors = true
    ingest.onCommitted((batch) => {
      if (target === 'seq') {
        // @ts-expect-error Deliberately violate the deeply readonly subscriber API.
        batch[0]!.seq = 99
      } else if (target === 'data' && batch[0]?.type === 'message.completed') {
        // @ts-expect-error Deliberately mutate a nested, frozen payload.
        batch[0].data.messageId = 'mutated'
      } else {
        // @ts-expect-error Deliberately mutate the frozen batch array.
        batch.length = 0
      }
    })
    const captured: DeepReadonly<StreamEvent[]>[] = []
    ingest.onCommitted((batch) => {
      captured.push(batch)
    })
    const result = await ingest.submit(observation('one'))
    await ingest.flushListeners()
    expect(result).toEqual({ status: 'applied', seqs: [1] })
    expect(captured).toEqual([persistedEvents()])
    expect(captured[0]?.[0]?.seq).toBe(1)
    expect(captured[0]?.[0]?.data).toEqual(draft('one').data)
    expect(Object.isFrozen(captured[0])).toBe(true)
    expect(Object.isFrozen(captured[0]?.[0])).toBe(true)
    expect(Object.isFrozen(captured[0]?.[0]?.data)).toBe(true)
    expect(listenerLog).toHaveBeenCalledExactlyOnceWith(
      'Ingest committed listener failed',
      expect.any(TypeError),
    )
  },
)

test('each async listener delivers batches in order while the writer and other listeners continue', async () => {
  const gate = Promise.withResolvers<void>()
  const started: number[] = []
  const delivered: number[] = []
  const fast: number[] = []
  ingest.onCommitted(async (batch) => {
    const seq = batch[0]!.seq
    started.push(seq)
    if (seq === 1) await gate.promise
    delivered.push(seq)
  })
  ingest.onCommitted((batch) => {
    fast.push(batch[0]!.seq)
  })
  try {
    await Promise.all([ingest.submit(observation('one')), ingest.submit(observation('two'))])
    await ingest.drain()
    expect(headSeq(db.sqlite)).toBe(2)
    expect(started).toEqual([1])
    expect(delivered).toEqual([])
    expect(fast).toEqual([1, 2])
    let flushed = false
    const flush = ingest.flushListeners().then(() => {
      flushed = true
    })
    await Promise.resolve()
    expect(flushed).toBe(false)
    gate.resolve()
    await flush
    expect(started).toEqual([1, 2])
    expect(delivered).toEqual([1, 2])
    expect(listenerLog).not.toHaveBeenCalled()
  } finally {
    gate.resolve()
  }
})

test('old unsubscribe handles do not remove a later registration of the same callback', async () => {
  const listener = vi.fn()
  const unsubscribe = ingest.onCommitted(listener)
  unsubscribe()
  ingest.onCommitted(listener)
  unsubscribe()
  await ingest.submit(observation('one'))
  await ingest.flushListeners()
  expect(listener).toHaveBeenCalledOnce()
})

test('SCORE-033: close waits for a committed listener held at an await', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const log: string[] = []
  let entered!: () => void
  const inside = new Promise<void>((resolve) => (entered = resolve))
  ingest.onCommitted(async () => {
    entered()
    await held
    log.push('listener done')
  })
  await ingest.submit(observation('one'))
  await inside
  const closed = ingest.close().then(() => log.push('closed'))
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve))
  expect(log).toEqual([])
  release()
  await closed
  expect(log).toEqual(['listener done', 'closed'])
})
