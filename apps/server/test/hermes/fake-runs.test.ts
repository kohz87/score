import type { StreamEvent } from '@score/contract'
import { expect, test } from 'vitest'
import { createScenario, scenarioDuration } from '../../src/hermes/fake/scenario.ts'
import { schedulerStart } from './fake-scheduler.ts'
import {
  eventsFor,
  installFakeHooks,
  playScenario,
  SCENARIO_JOB_EVENTS,
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

test('startRun queues, runs and completes, with concurrent and completed retries idempotent per turnId', async () => {
  await play()
  const request = { agentId: 'builder', input: 'Add feed pagination', turnId: 'turn-one' }
  const [first, retry] = await Promise.all([port.startRun(request), port.startRun(request)])
  expect(retry).toEqual(first)
  const updates = () =>
    events().filter(
      (event): event is Extract<StreamEvent, { type: 'run.updated' }> =>
        event.type === 'run.updated' && event.data.id === first!.runId,
    )
  expect(updates().map((event) => event.data.status)).toEqual(['queued'])
  await scheduler.advance(250)
  expect(updates().map((event) => event.data.status)).toEqual(['queued', 'running'])
  await scheduler.advance(750)
  expect(updates().map((event) => event.data.status)).toEqual(['queued', 'running', 'completed'])
  expect(updates().at(-1)?.data.endedAt).toBe(new Date(scheduler.now()).toISOString())
  expect(await port.startRun(request)).toEqual(first)
  await port.stopRun({ agentId: 'builder', runId: first!.runId })
  expect(updates()).toHaveLength(3)
  const next = await port.startRun({ ...request, turnId: 'turn-two' })
  expect(next.runId).not.toBe(first!.runId)
})

test.each([0, 250])(
  'stopRun cancels at %i ms once and delayed transitions cannot regress it',
  async (at) => {
    await play()
    const request = { agentId: 'builder', input: 'Check pagination', turnId: 'cancel-turn' }
    const { runId } = await port.startRun(request)
    await scheduler.advance(at)
    const count = events().length
    await port.stopRun({ agentId: 'reviewer', runId })
    await port.stopRun({ agentId: 'builder', runId: 'unknown' })
    expect(events()).toHaveLength(count)
    await Promise.all([
      port.stopRun({ agentId: 'builder', runId }),
      port.stopRun({ agentId: 'builder', runId }),
    ])
    await scheduler.advance(5000)
    const updates = events().filter(
      (event): event is Extract<StreamEvent, { type: 'run.updated' }> =>
        event.type === 'run.updated' && event.data.id === runId,
    )
    expect(updates.at(-1)?.data.status).toBe('cancelled')
    expect(updates.filter((event) => event.data.status === 'cancelled')).toHaveLength(1)
    expect(await port.startRun(request)).toEqual({ runId })
  },
)

test('stop is idempotent, drains in-flight submissions and cancels remaining timers before restart', async () => {
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  await port.start({
    async submit(observation) {
      entered.resolve()
      await gate.promise
      return sink.submit(observation)
    },
  })
  const advancing = scheduler.advance(0)
  await entered.promise
  let stopped = false
  const stopping = port.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  expect(scheduler.pending).toBe(0)
  gate.resolve()
  await stopping
  await advancing
  await port.stop()
  expect(events()).toHaveLength(1)
  await scheduler.advance(20000)
  expect(events()).toHaveLength(1)
  await play()
  expect(events()).toHaveLength(5 + createScenario(schedulerStart).length + SCENARIO_JOB_EVENTS)
})

test('stopping a scripted run prevents later script steps from undoing the cancellation', async () => {
  await port.start(sink)
  await scheduler.advance(600 * 18)
  await port.stopRun({ agentId: 'builder', runId: 'scenario-build-0' })
  await scheduler.advance(scenarioDuration)
  const updates = events().filter(
    (event): event is Extract<StreamEvent, { type: 'run.updated' }> =>
      event.type === 'run.updated' && event.data.id === 'scenario-build-0',
  )
  expect(updates.map((event) => event.data.status)).toEqual(['queued', 'cancelled'])
  expect(observations).toHaveLength(createScenario(schedulerStart).length + 1)
  expect(
    results.filter((result) => result.status === 'applied' && result.seqs.length === 0),
  ).toHaveLength(3)
})

test('stopped runs reject commands and unknown agents cannot start work', async () => {
  const req = { agentId: 'unknown', input: 'Hello', turnId: 'turn-unknown' }
  await expect(port.startRun(req)).rejects.toMatchObject({ status: 503 })
  await port.start(sink)
  await expect(port.startRun(req)).rejects.toMatchObject({ status: 404 })
})
