import { expect, test, vi } from 'vitest'
import { createIngest } from '../../src/hub/index.ts'
import { observation, rows, setupIngestTest, type IngestTestState } from './ingest-helpers.ts'

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

function cursor(scope = 'runs', source = 'score') {
  return db.sqlite
    .prepare('SELECT cursor, incarnation FROM ingest_checkpoints WHERE source = ? AND scope = ?')
    .get(source, scope)
}

test('checkpoint positions never regress on delayed duplicate or lower observations', async () => {
  await ingest.submit(observation('10'))
  await ingest.submit(observation('20'))
  const before = rows('ingest_checkpoints')
  expect(await ingest.submit(observation('10'))).toEqual({ status: 'duplicate' })
  await ingest.submit(observation('15'))
  expect(rows('ingest_checkpoints')).toEqual(before)
  expect(cursor()).toEqual({ cursor: '20', incarnation: 'incarnation-1' })
})

test.each(['retry', 'release'] as const)(
  'a failed checkpoint holds later progress until %s, with other scopes and sources unaffected',
  async (resolution) => {
    await ingest.submit(observation('9'))
    await expect(
      ingest.submit(
        observation('10', {
          apply(ctx) {
            observation('10').apply(ctx)
            throw new Error('failed ten')
          },
        }),
      ),
    ).rejects.toThrow('failed ten')
    expect(await ingest.submit(observation('11'))).toEqual({ status: 'applied', seqs: [2] })
    expect(cursor()).toEqual({ cursor: '9', incarnation: 'incarnation-1' })
    expect(rows('test_runs').map((row) => row.id)).toEqual(['9', '11'])
    await ingest.submit(
      observation('other-scope', {
        checkpoint: { scope: 'messages', position: 50, incarnation: null },
      }),
    )
    await ingest.submit(
      observation('other-source', {
        source: 'kanban',
        checkpoint: { scope: 'runs', position: 60, incarnation: null },
      }),
    )
    expect(cursor('messages')).toEqual({ cursor: '50', incarnation: null })
    expect(cursor('runs', 'kanban')).toEqual({ cursor: '60', incarnation: null })
    if (resolution === 'retry') {
      await ingest.submit(observation('10'))
      expect(cursor()?.cursor).toBe('10')
    } else {
      ingest.releaseHold('score', 'runs')
    }
    expect(await ingest.submit(observation('11'))).toEqual({ status: 'duplicate' })
    expect(cursor()?.cursor).toBe('11')
    expect(
      rows('test_runs')
        .map((row) => row.id)
        .filter((id) => id === '10'),
    ).toHaveLength(resolution === 'retry' ? 1 : 0)
  },
)

test('multiple failed positions retain the earliest barrier until each retry commits', async () => {
  await ingest.submit(observation('1'))
  for (const position of ['10', '12']) {
    await expect(
      ingest.submit(
        observation(position, {
          apply() {
            throw new Error('failed')
          },
        }),
      ),
    ).rejects.toThrow('failed')
  }
  await ingest.submit(observation('13'))
  expect(cursor()?.cursor).toBe('1')
  await ingest.submit(observation('12'))
  expect(cursor()?.cursor).toBe('1')
  await ingest.submit(observation('10'))
  expect(cursor()?.cursor).toBe('10')
  await ingest.submit(observation('13'))
  expect(cursor()?.cursor).toBe('13')
})

test.each([null, 'new-incarnation'])(
  'incarnation reset to %s requires explicit authorization and rolls back on mismatch',
  async (incarnation) => {
    await ingest.submit(observation('20'))
    const checkpoint = { scope: 'runs', position: 1, incarnation }
    await expect(ingest.submit(observation('reset', { checkpoint }))).rejects.toThrow(
      'requires resetIncarnation',
    )
    expect(rows('test_runs').map((row) => row.id)).toEqual(['20'])
    expect(rows('events')).toHaveLength(1)
    expect(rows('ingest_keys')).toHaveLength(1)
    expect(cursor()?.cursor).toBe('20')
    await ingest.submit(
      observation('reset', { checkpoint: { ...checkpoint, resetIncarnation: true } }),
    )
    expect(cursor()).toEqual({ cursor: '1', incarnation })
  },
)

test('a null incarnation cannot switch to a string without reset', async () => {
  await ingest.submit(
    observation('one', { checkpoint: { scope: 'runs', position: 1, incarnation: null } }),
  )
  await expect(ingest.submit(observation('two'))).rejects.toThrow('requires resetIncarnation')
  expect(cursor()).toEqual({ cursor: '1', incarnation: null })
})

test('a hold with no stored checkpoint leaves it absent until the failed observation succeeds', async () => {
  await expect(
    ingest.submit(
      observation('10', {
        apply() {
          throw new Error('failed')
        },
      }),
    ),
  ).rejects.toThrow()
  await ingest.submit(observation('11'))
  expect(cursor()).toBeUndefined()
  await ingest.submit(observation('10'))
  expect(cursor()?.cursor).toBe('10')
})

test('holds are in-memory and restart resumes from the durable checkpoint', async () => {
  await ingest.submit(observation('9'))
  await expect(
    ingest.submit(
      observation('10', {
        apply() {
          throw new Error('failed')
        },
      }),
    ),
  ).rejects.toThrow()
  await ingest.submit(observation('11'))
  await ingest.close()
  expect(cursor()?.cursor).toBe('9')
  ingest = createIngest(db)
  await ingest.submit(observation('10'))
  expect(cursor()?.cursor).toBe('10')
})

test('transaction acquisition failure holds checkpoints just like an apply failure', async () => {
  await ingest.submit(observation('9'))
  vi.spyOn(db, 'tx').mockImplementationOnce(() => {
    throw new Error('database busy')
  })
  await expect(ingest.submit(observation('10'))).rejects.toThrow('database busy')
  await ingest.submit(observation('11'))
  expect(cursor()?.cursor).toBe('9')
  await ingest.submit(observation('10'))
  await ingest.submit(observation('11'))
  expect(cursor()?.cursor).toBe('11')
})

test('checkpoint holds also cover metadata failures with a valid source and position', async () => {
  await ingest.submit(observation('9'))
  await expect(ingest.submit(observation('10', { identity: '' }))).rejects.toThrow()
  await ingest.submit(observation('11'))
  expect(cursor()?.cursor).toBe('9')
  await ingest.submit(observation('10'))
  expect(cursor()?.cursor).toBe('10')
})

test('observation metadata is captured at submission and cannot redirect its checkpoint or ingest key', async () => {
  const obs = observation('one')
  const submitted = ingest.submit(obs)
  obs.identity = 'different'
  obs.checkpoint!.position = 50
  obs.checkpoint!.scope = 'other'
  await submitted
  expect(rows('ingest_keys')[0]?.identity).toBe('one')
  expect(cursor()?.cursor).toBe('1')
  expect(cursor('other')).toBeUndefined()
})
