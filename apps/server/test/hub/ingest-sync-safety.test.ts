import type { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { type DomainEventDraft, type Observation } from '../../src/hub/index.ts'
import {
  draft,
  observation,
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

test.each(['AsyncFunction', 'AsyncGeneratorFunction'] as const)(
  'native %s apply is rejected before invocation',
  async (kind) => {
    let invoked = false
    const callback =
      kind === 'AsyncFunction'
        ? async ({ sqlite }: Parameters<Observation['apply']>[0]) => {
            invoked = true
            sqlite.exec("INSERT INTO test_runs VALUES ('late', 'queued', '')")
            return []
          }
        : async function* ({ sqlite }: Parameters<Observation['apply']>[0]) {
            invoked = true
            sqlite.exec("INSERT INTO test_runs VALUES ('late', 'queued', '')")
            yield draft('one')
          }
    await expect(
      ingest.submit(observation('one', { apply: callback as unknown as Observation['apply'] })),
    ).rejects.toThrow('must be synchronous')
    expect(invoked).toBe(false)
    expect(rows('test_runs')).toEqual([])
    expect(rows('events')).toEqual([])
    expect(rows('ingest_keys')).toEqual([])
  },
)

test('unexpected async continuation cannot write after rollback through connection, cached method or statement', async () => {
  const gate = Promise.withResolvers<void>()
  const errors: unknown[] = []
  let continuation: Promise<void> | undefined
  await expect(
    ingest.submit(
      observation('one', {
        apply({ sqlite }) {
          sqlite.exec("INSERT INTO test_runs VALUES ('before', 'queued', '')")
          const cachedExec = sqlite.exec
          const statement = sqlite.prepare("INSERT INTO test_runs VALUES ('after', 'queued', '')")
          const cachedRun = statement.run
          continuation = (async () => {
            await gate.promise
            for (const write of [
              () => sqlite.exec("INSERT INTO test_runs VALUES ('late', 'queued', '')"),
              () => cachedExec("INSERT INTO test_runs VALUES ('cached', 'queued', '')"),
              () => statement.run(),
              () => cachedRun(),
            ]) {
              try {
                write()
              } catch (error) {
                errors.push(error)
              }
            }
          })()
          return continuation as unknown as DomainEventDraft[]
        },
      }),
    ),
  ).rejects.toThrow('must be synchronous')
  gate.resolve()
  await continuation
  expect(errors).toHaveLength(4)
  for (const error of errors) expect(error).toBeInstanceOf(Error)
  for (const table of ['test_runs', 'events', 'ingest_keys', 'ingest_checkpoints'])
    expect(rows(table)).toEqual([])
})

test('escaped transaction access expires after a successful commit too', async () => {
  let escaped: DatabaseSync | undefined
  await ingest.submit(
    observation('one', {
      apply(ctx) {
        escaped = ctx.sqlite
        return observation('one').apply(ctx)
      },
    }),
  )
  expect(() => escaped!.exec('DELETE FROM test_runs')).toThrow()
  expect(rows('test_runs')).toHaveLength(1)
})

test('escaped SQLite write iterators expire with their transaction', async () => {
  let iterator: NodeJS.Iterator<Record<string, import('node:sqlite').SQLOutputValue>> | undefined
  await ingest.submit(
    observation('one', {
      apply({ sqlite }) {
        iterator = sqlite
          .prepare("INSERT INTO test_runs VALUES ('late', 'queued', '') RETURNING id")
          .iterate()
        return []
      },
    }),
  )
  expect(() => iterator!.next()).toThrow()
  expect(rows('test_runs')).toEqual([])
})

test('unexpected promise rejections are handled when a late write throws', async () => {
  const gate = Promise.withResolvers<void>()
  let late: Promise<void> | undefined
  await expect(
    ingest.submit(
      observation('one', {
        apply({ sqlite }) {
          late = (async () => {
            await gate.promise
            sqlite.exec("INSERT INTO test_runs VALUES ('late', 'queued', '')")
          })()
          return late as unknown as DomainEventDraft[]
        },
      }),
    ),
  ).rejects.toThrow('must be synchronous')
  gate.resolve()
  await expect(late).rejects.toThrow()
  expect(rows('test_runs')).toEqual([])
})
