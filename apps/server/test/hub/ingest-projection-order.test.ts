import { expect, test } from 'vitest'
import { defineLifecycle, guardedUpsert, type GuardedUpsertResult } from '../../src/hub/index.ts'
import {
  draft,
  observation,
  persistedEvents,
  rows,
  setupIngestTest,
  type IngestTestState,
} from './ingest-helpers.ts'

const lifecycle = defineLifecycle({
  states: ['queued', 'running', 'completed', 'failed'],
  terminal: ['completed', 'failed'],
  order: ['queued', 'running', 'completed', 'failed'],
})
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

test('delayed observations cannot regress projections or emit misleading events, but advance checkpoints', async () => {
  const outcomes: GuardedUpsertResult[] = []
  for (const [index, state] of [
    'queued',
    'running',
    'queued',
    'completed',
    'running',
    'failed',
    'completed',
  ].entries()) {
    await ingest.submit(
      observation(String(index), {
        apply({ sqlite }) {
          const result = guardedUpsert(sqlite, {
            table: 'test_runs',
            key: { id: 'run' },
            stateColumn: 'state',
            lifecycle,
            values: { state, updated_at: String(index) },
          })
          outcomes.push(result)
          return result === 'applied' ? [draft(String(index))] : []
        },
      }),
    )
  }
  expect(outcomes).toEqual([
    'applied',
    'applied',
    'ignored_regression',
    'applied',
    'ignored_terminal',
    'ignored_terminal',
    'ignored_terminal',
  ])
  expect(rows('test_runs')).toEqual([{ id: 'run', state: 'completed', updated_at: '3' }])
  expect(persistedEvents().map((event) => event.data)).toEqual(
    ['0', '1', '3'].map((id) => draft(id).data),
  )
  expect(rows('ingest_keys')).toHaveLength(7)
  expect(rows('ingest_checkpoints')[0]?.cursor).toBe('6')
})
