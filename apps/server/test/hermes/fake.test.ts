import { StreamEventSchema, type StreamEvent } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { createHermesPort, type HermesPort, type ObservationSink } from '../../src/hermes/index.ts'
import { createScenario } from '../../src/hermes/fake/scenario.ts'
import {
  createIngest,
  type Ingest,
  type IngestResult,
  type Observation,
} from '../../src/hub/ingest.ts'
import { FakeScheduler, schedulerStart } from './fake-scheduler.ts'

let directory: string
let db: ScoreDb
let ingest: Ingest
let port: HermesPort
let scheduler: FakeScheduler
let sink: ObservationSink
let observations: Observation[]
let results: IngestResult[]
let onError: ReturnType<typeof vi.fn<(error: unknown) => void>>

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'score-fake-'))
  db = openDatabase(join(directory, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  ingest = createIngest(db, { clock: () => scheduler.now() })
  observations = []
  results = []
  sink = {
    async submit(observation) {
      observations.push(observation)
      const result = await ingest.submit(observation)
      results.push(result)
      return result
    },
  }
  onError = vi.fn<(error: unknown) => void>()
  port = createHermesPort(loadConfig({}), { scheduler, onError })
})

afterEach(async () => {
  await port.stop()
  await ingest.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

function events(): StreamEvent[] {
  return db.sqlite
    .prepare('SELECT seq, ts, type, data FROM events ORDER BY seq')
    .all()
    .map((row) => StreamEventSchema.parse({ ...row, data: JSON.parse(String(row.data)) }))
}

async function play(): Promise<void> {
  await port.start(sink)
  await scheduler.advance(10000)
  await ingest.drain()
}

test('the whole fake scenario passes real ingest validation and covers every durable event', async () => {
  await play()
  const stored = events()
  const expectedTypes = StreamEventSchema.options.map((schema) => schema.shape.type.value)
  expect([...new Set(stored.map((event) => event.type))].sort()).toEqual(expectedTypes.sort())
  expect(stored).toHaveLength(createScenario(schedulerStart).length)
  expect(
    stored.filter((event) => event.type === 'approval.requested').map((event) => event.data.origin),
  ).toEqual(['score-run', 'gateway', 'kanban'])
  expect(
    stored.filter((event) => event.type === 'watch.frame').map((event) => event.data.surface),
  ).toEqual(['terminal', 'editor', 'browser'])
  expect(stored.find((event) => event.type === 'gap.recorded')?.data).toMatchObject({
    from: '2026-01-01T12:00:04.000Z',
    to: '2026-01-01T12:00:05.000Z',
  })
  expect(results.every((result) => result.status === 'applied')).toBe(true)
  expect(observations.every((observation) => observation.source === 'fake')).toBe(true)
  const session = observations[0]!.identity.split(':')[0]
  expect(observations.map((observation) => observation.identity)).toEqual(
    stored.map((_, index) => `${session}:${index}`),
  )
  expect(onError).not.toHaveBeenCalled()
  expect(scheduler.pending).toBe(0)
  await scheduler.advance(60000)
  expect(events()).toEqual(stored)
})

test('the same scheduler produces identical types and data and a restart replays on the same DB', async () => {
  await play()
  const first = events()
  const firstIdentities = observations.map((observation) => observation.identity)
  await port.stop()
  await ingest.close()
  db.close()
  db = openDatabase(join(directory, 'score.db'))
  scheduler = new FakeScheduler()
  ingest = createIngest(db, { clock: () => scheduler.now() })
  port = createHermesPort(loadConfig({}), { scheduler, onError })
  await play()
  const second = events().slice(first.length)
  expect(second.map(({ type, data }) => ({ type, data }))).toEqual(
    first.map(({ type, data }) => ({ type, data })),
  )
  expect(second[0]!.seq).toBe(first.length + 1)
  expect(new Set(observations.map((observation) => observation.identity)).size).toBe(
    first.length * 2,
  )
  expect(observations[first.length]!.identity).not.toBe(firstIdentities[0])
  expect(results.every((result) => result.status === 'applied')).toBe(true)
})

test.each(['score-run', 'gateway', 'kanban'] as const)(
  'delivers a pending %s decision exactly once, even concurrently',
  async (origin) => {
    await port.start(sink)
    await scheduler.advance(2600)
    const req = { approvalId: `approval-${origin}`, choice: 'once' as const }
    expect(await Promise.all([port.deliverDecision(req), port.deliverDecision(req)])).toEqual([
      'applied',
      'not_pending',
    ])
    const update = events().at(-1)
    expect(update?.type).toBe('approval.updated')
    expect(update?.data).toMatchObject({
      id: req.approvalId,
      phase: 'decided',
      status: 'approved',
      decision: { choice: 'once', by: 'you', at: new Date(scheduler.now()).toISOString() },
      delivery: 'applied',
    })
    await scheduler.advance(10000)
    expect(
      events().filter(
        (event) => event.type === 'approval.updated' && event.data.id === req.approvalId,
      ),
    ).toHaveLength(1)
  },
)

test('unknown and already decided approvals are not pending; denial is attributed to you', async () => {
  await play()
  const count = events().length
  expect(await port.deliverDecision({ approvalId: 'unknown', choice: 'deny' })).toBe('not_pending')
  expect(await port.deliverDecision({ approvalId: 'approval-score-run', choice: 'deny' })).toBe(
    'not_pending',
  )
  expect(events()).toHaveLength(count)
  expect(await port.deliverDecision({ approvalId: 'approval-gateway', choice: 'deny' })).toBe(
    'applied',
  )
  expect(events().at(-1)?.data).toMatchObject({
    status: 'denied',
    decision: { choice: 'deny', by: 'you' },
    delivery: 'applied',
  })
  expect(await port.deliverDecision({ approvalId: 'approval-kanban', choice: 'session' })).toBe(
    'failed',
  )
})

test('a failed decision submission leaves the approval pending for retry', async () => {
  await play()
  const submit = vi.spyOn(sink, 'submit').mockRejectedValueOnce(new Error('ingest failure'))
  const req = { approvalId: 'approval-gateway', choice: 'once' as const }
  expect(await port.deliverDecision(req)).toBe('failed')
  expect(await port.deliverDecision(req)).toBe('applied')
  expect(submit).toHaveBeenCalledTimes(2)
})

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
  expect(events()).toHaveLength(1 + createScenario(schedulerStart).length)
})

test('stopping a scripted run prevents later script steps from undoing the cancellation', async () => {
  await port.start(sink)
  await scheduler.advance(600)
  await port.stopRun({ agentId: 'builder', runId: 'scenario-build' })
  await scheduler.advance(10000)
  const updates = events().filter(
    (event): event is Extract<StreamEvent, { type: 'run.updated' }> =>
      event.type === 'run.updated' && event.data.id === 'scenario-build',
  )
  expect(updates.map((event) => event.data.status)).toEqual(['queued', 'cancelled'])
  expect(observations).toHaveLength(createScenario(schedulerStart).length + 1)
  expect(
    results.filter((result) => result.status === 'applied' && result.seqs.length === 0),
  ).toHaveLength(3)
})

test('scheduled ingest failures are reported and do not produce unhandled rejections', async () => {
  const failure = new Error('Ingest unavailable')
  vi.spyOn(sink, 'submit').mockRejectedValueOnce(failure)
  await play()
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure)
  expect(events()).toHaveLength(createScenario(schedulerStart).length - 1)
  expect(scheduler.pending).toBe(0)
})

test('fake status and agent styles match the defaults; returned objects cannot mutate port state', async () => {
  expect(port.status()).toMatchObject({
    hermes: {
      reachable: true,
      apiServer: true,
      servedProfiles: ['lead', 'builder', 'reviewer', 'designer'],
    },
    bridge: { producers: 0 },
    compatibility: { fingerprint: 'fake', tested: true, disabled: [] },
    agentIsolation: 'same_user',
    degraded: [],
  })
  const agents = await port.listAgents()
  expect(agents.map(({ id, style }) => ({ id, ...style }))).toEqual([
    { id: 'lead', color: '#6B4EFF', shape: 'circle-dot' },
    { id: 'builder', color: '#19C39A', shape: 'triangle' },
    { id: 'reviewer', color: '#FFB61E', shape: 'diamond' },
    { id: 'designer', color: '#FF6B8A', shape: 'square' },
  ])
  agents[0]!.style.color = '#000000'
  expect((await port.listAgents())[0]!.style.color).toBe('#6B4EFF')
  await port.start(sink)
  await port.start(sink)
  await scheduler.advance(900)
  expect(observations).toHaveLength(9)
  expect((await port.listAgents())[1]!.status).toBe('working')
})

test('speed scales timer delays while scenario data stays deterministic', async () => {
  port = createHermesPort(loadConfig({ SCORE_FAKE_SPEED: '100' }), { scheduler, onError })
  await port.start(sink)
  await scheduler.advance(99)
  expect(events().at(-1)?.type).toBe('memory.saved')
  await scheduler.advance(1)
  expect(events()).toHaveLength(createScenario(schedulerStart).length)
  expect(events().at(-1)?.data).toMatchObject({ updatedAt: '2026-01-01T12:00:10.000Z' })
})

test('overdue timers cannot reorder scripted events or skip the running transition', async () => {
  await port.start(sink)
  const { runId } = await port.startRun({
    agentId: 'lead',
    input: 'Summarize the feed',
    turnId: 'late-turn',
  })
  await scheduler.advance(10000, true)
  const stored = events()
  expect(
    stored
      .filter((event) => event.type === 'run.updated' && event.data.id === runId)
      .map((event) => event.data),
  ).toMatchObject([{ status: 'queued' }, { status: 'running' }, { status: 'completed' }])
  expect(
    stored
      .filter((event) => !(event.type === 'run.updated' && event.data.id === runId))
      .map((event) => event.type),
  ).toEqual(createScenario(schedulerStart).map((step) => step.kind))
})

test('stopped runs reject commands and unknown agents cannot start work', async () => {
  const req = { agentId: 'unknown', input: 'Hello', turnId: 'turn-unknown' }
  await expect(port.startRun(req)).rejects.toMatchObject({ status: 503 })
  await port.start(sink)
  await expect(port.startRun(req)).rejects.toMatchObject({ status: 404 })
})
