import { expect, test } from 'vitest'
import { headSeq, snapshot } from '../../src/hub/index.ts'
import {
  draft,
  now,
  observation,
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

test('snapshot holds projection and head in one WAL read while another connection commits both', async () => {
  await ingest.submit(observation('one'))
  const writer = secondConnection()
  const read = snapshot(db, (sqlite) => {
    expect(sqlite.isTransaction).toBe(true)
    const before = sqlite.prepare('SELECT id FROM test_runs ORDER BY id').all()
    writer.exec('BEGIN IMMEDIATE')
    writer.prepare('INSERT INTO test_runs VALUES (?, ?, ?)').run('two', 'queued', now)
    writer
      .prepare('INSERT INTO events (ts, type, data) VALUES (?, ?, ?)')
      .run(now, 'message.completed', JSON.stringify(draft('two').data))
    writer.exec('COMMIT')
    expect(sqlite.prepare('SELECT id FROM test_runs ORDER BY id').all()).toEqual(before)
    expect(headSeq(sqlite)).toBe(1)
    return before
  })
  expect(read).toEqual({ asOfSeq: 1, data: [{ id: 'one' }] })
  expect(
    snapshot(db, (sqlite) => sqlite.prepare('SELECT id FROM test_runs ORDER BY id').all()),
  ).toEqual({
    asOfSeq: 2,
    data: [{ id: 'one' }, { id: 'two' }],
  })
})

test('snapshot establishes its read before calling a reader that triggers a concurrent commit', async () => {
  await ingest.submit(observation('one'))
  const writer = secondConnection()
  expect(
    snapshot(db, (sqlite) => {
      writer.exec('DELETE FROM test_runs')
      return sqlite.prepare('SELECT id FROM test_runs').all()
    }),
  ).toEqual({ asOfSeq: 1, data: [{ id: 'one' }] })
})

test('head is zero initially, survives pruning, and subsequent events keep increasing', async () => {
  expect(headSeq(db.sqlite)).toBe(0)
  expect(snapshot(db, () => [])).toEqual({ asOfSeq: 0, data: [] })
  await ingest.submit(observation('one'))
  await ingest.submit(observation('two'))
  db.tx((sqlite) => sqlite.exec('DELETE FROM events'))
  expect(headSeq(db.sqlite)).toBe(2)
  expect(snapshot(db, (sqlite) => sqlite.prepare('SELECT * FROM events').all())).toEqual({
    asOfSeq: 2,
    data: [],
  })
  expect(await ingest.submit(observation('three'))).toEqual({ status: 'applied', seqs: [3] })
})

test('snapshot errors and async readers release the transaction', () => {
  expect(() =>
    snapshot(db, () => {
      throw new Error('read failed')
    }),
  ).toThrow('read failed')
  expect(db.sqlite.isTransaction).toBe(false)
  expect(() => snapshot(db, () => Promise.resolve([]))).toThrow('must be synchronous')
  expect(db.sqlite.isTransaction).toBe(false)
  expect(snapshot(db, () => 'ok')).toEqual({ asOfSeq: 0, data: 'ok' })
})
