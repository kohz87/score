import { expect, test } from 'vitest'
import { createIngest } from '../../src/hub/index.ts'
import {
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

test.each([
  { source: '' },
  { identity: '' },
  { checkpoint: { scope: '', position: 1, incarnation: null } },
])('invalid metadata %j rejects without writes and does not wedge the writer', async (metadata) => {
  await expect(ingest.submit(observation('one', metadata))).rejects.toThrow()
  expect(rows('ingest_keys')).toEqual([])
  expect(rows('test_runs')).toEqual([])
  expect(await ingest.submit(observation('two'))).toEqual({ status: 'applied', seqs: [1] })
})

test('1,000 sequential observations preserve strict seq order within a few seconds', async () => {
  const started = performance.now()
  for (let index = 1; index <= 1000; index++) {
    expect(await ingest.submit(observation(String(index)))).toEqual({
      status: 'applied',
      seqs: [index],
    })
  }
  expect(persistedEvents().map((event) => event.seq)).toEqual(
    Array.from({ length: 1000 }, (_, index) => index + 1),
  )
  expect(rows('test_runs')).toHaveLength(1000)
  expect(performance.now() - started).toBeLessThan(3000)
})

test('only one ingest owns a ScoreDb until close drains and releases it', async () => {
  expect(() => createIngest(db)).toThrow('already has an open ingest')
  const submitted = ingest.submit(observation('one'))
  const closed = ingest.close()
  expect(ingest.close()).toBe(closed)
  expect(() => createIngest(db)).toThrow('already has an open ingest')
  await expect(ingest.submit(observation('two'))).rejects.toThrow('closed')
  expect(() => ingest.onCommitted(() => {})).toThrow('closed')
  await closed
  expect(await submitted).toEqual({ status: 'applied', seqs: [1] })
  ingest = createIngest(db)
  expect(await ingest.submit(observation('two'))).toEqual({ status: 'applied', seqs: [2] })
})
