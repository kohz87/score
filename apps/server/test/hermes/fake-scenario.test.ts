import { StreamEventSchema, type StreamEvent } from '@score/contract'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { loadConfig } from '../../src/config.ts'
import { openDatabase } from '../../src/db/index.ts'
import { createHermesPort } from '../../src/hermes/index.ts'
import { createScenario, scenarioDuration } from '../../src/hermes/fake/scenario.ts'
import { createIngest } from '../../src/hub/ingest.ts'
import { FakeScheduler, schedulerStart } from './fake-scheduler.ts'
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

test('the whole fake scenario passes real ingest validation and covers every scripted durable event', async () => {
  await play()
  const stored = events()
  // message.deleted and message.updated only follow a person's Delete or edit (message.progressed a live run's tool or reasoning step), never a scripted step; knowledge.changed
  // comes from the vault (6.2), and room-project.* from a person's organising of rooms (5.26), not from the Hermes scenario.
  const expectedTypes = StreamEventSchema.options
    .map((schema) => schema.shape.type.value)
    .filter(
      (type) =>
        type !== 'message.deleted' &&
        type !== 'message.updated' &&
        type !== 'message.progressed' &&
        type !== 'knowledge.changed' &&
        // The shared look is changed by a person (themes, 9.1).
        type !== 'look.changed' &&
        // Kanban attempts come from the attempts projection (5.17a-1), never from the scripted scenario.
        type !== 'attempt.updated' &&
        // Orchestrations (7.5a) are started by a person, never by the scripted scenario.
        type !== 'orchestration.upserted' &&
        type !== 'orchestration.fence.updated' &&
        // Workflow runs (7.1a) are started by a person, like orchestrations.
        type !== 'workflow.run.upserted' &&
        type !== 'room.version.created' &&
        // Deleting a room and compacting a session are person actions (5.36).
        type !== 'room.deleted' &&
        type !== 'session.compacted' &&
        type !== 'room-project.upserted' &&
        // Exchanges (11.1b) come from people and agent actions; 11.2's fake team room scripts them.
        type !== 'exchange.upserted' &&
        // Pinning a decision is a person's action (11.2).
        type !== 'room.pins.changed' &&
        // Deleting a job from its menu is a person's action (decision 121).
        type !== 'job.deleted' &&
        // Agent questions (decision 128) follow a person's "ask me" message, never the scripted scenario.
        type !== 'question.requested' &&
        type !== 'question.updated' &&
        // The fake adapter starts no subagents of its own (e2e/subagents.spec.ts covers the limits).
        type !== 'subagent.upserted' &&
        // A chat's effort and model are set by the person (decisions 178, 182).
        type !== 'effort.changed' &&
        type !== 'model.changed' &&
        type !== 'subagents.changed',
    )
  expect([...new Set(stored.map((event) => event.type))].sort()).toEqual(expectedTypes.sort())
  expect(stored).toHaveLength(createScenario(schedulerStart).length + 4 + SCENARIO_JOB_EVENTS)
  // The extra events are exactly the scenario room's job following its messages.
  const jobs = stored.filter((event) => event.type === 'job.upserted')
  expect(jobs).toHaveLength(SCENARIO_JOB_EVENTS)
  expect(jobs.every((event) => event.data.roomId === 'room-activity-feed')).toBe(true)
  expect(
    stored.filter((event) => event.type === 'approval.requested').map((event) => event.data.origin),
  ).toEqual(['score-run', 'score-run', 'gateway', 'kanban'])
  expect(
    stored.filter((event) => event.type === 'watch.frame').map((event) => event.data.surface),
  ).toEqual(['terminal', 'editor', 'browser'])
  // Scripted frames are stored with a per-agent seq, so the Watch endpoints can replay them.
  expect(
    db.sqlite
      .prepare('SELECT agent_id, seq, surface FROM watch_frames ORDER BY agent_id, seq')
      .all(),
  ).toEqual([
    { agent_id: 'builder', seq: 1, surface: 'terminal' },
    { agent_id: 'builder', seq: 2, surface: 'editor' },
    { agent_id: 'designer', seq: 1, surface: 'browser' },
  ])
  expect(stored.find((event) => event.type === 'gap.recorded')?.data).toMatchObject({
    from: '2026-01-01T12:01:12.000Z',
    to: '2026-01-01T12:01:30.000Z',
  })
  expect(results.every((result) => result.status === 'applied')).toBe(true)
  expect(observations.every((observation) => observation.source === 'fake')).toBe(true)
  const session = observations[0]!.identity.split(':')[0]
  expect(observations.map((observation) => observation.identity)).toEqual(
    createScenario(schedulerStart).map((_, index) => `${session}:0:${index}`),
  )
  expect(onError).not.toHaveBeenCalled()
  expect(scheduler.pending).toBe(0)
  await scheduler.advance(60000)
  expect(events()).toEqual(stored)
})

test('restart replays scenario observations while keeping durable approval decisions', async () => {
  await play()
  const first = events()
  const firstIdentities = observations.map((observation) => observation.identity)
  await port.stop()
  await ingest.close()
  db.close()
  db = openDatabase(join(directory, 'score.db'))
  scheduler = new FakeScheduler()
  ingest = createIngest(db, { clock: () => scheduler.now() })
  port = createHermesPort(loadConfig({ SCORE_FAKE_LOOP: 'false' }), { scheduler, onError })
  await play()
  const second = events().slice(first.length)
  expect(
    second
      .filter(
        (event) =>
          !event.type.startsWith('approval.') &&
          !event.type.startsWith('message.') &&
          // A job follows its messages, which a replay doesn't repeat.
          event.type !== 'job.upserted' &&
          event.type !== 'room.upserted',
      )
      .map(({ type, data }) => ({ type, data })),
  ).toEqual(
    first
      .filter(
        (event) =>
          !event.type.startsWith('approval.') &&
          !event.type.startsWith('message.') &&
          // A job follows its messages, which a replay doesn't repeat.
          event.type !== 'job.upserted' &&
          event.type !== 'room.upserted',
      )
      .map(({ type, data }) => ({ type, data })),
  )
  expect(
    second.filter((event) => event.type.startsWith('approval.')).map((event) => event.type),
  ).toEqual(Array(6).fill('approval.updated'))
  expect(
    second.find(
      (event) => event.type === 'approval.updated' && event.data.id === 'approval-score-run-0',
    )?.data,
  ).toMatchObject({
    status: 'approved',
    decision: { by: 'elsewhere' },
  })
  expect(second.filter((event) => event.type.startsWith('message.'))).toEqual([])
  expect(second.filter((event) => event.type === 'job.upserted')).toEqual([])
  expect(first.filter((event) => event.type === 'job.upserted')).toHaveLength(SCENARIO_JOB_EVENTS)
  // The scenario's own room.upserted step replays like every other non-message step; messages add none.
  expect(second.filter((event) => event.type === 'room.upserted')).toHaveLength(
    createScenario(0).filter((step) => step.kind === 'room.upserted').length,
  )
  expect(second[0]!.seq).toBe(first.length + 1)
  expect(new Set(observations.map((observation) => observation.identity)).size).toBe(
    createScenario(schedulerStart).length * 2,
  )
  expect(observations[createScenario(schedulerStart).length]!.identity).not.toBe(firstIdentities[0])
  expect(results.every((result) => result.status === 'applied')).toBe(true)
})

test('scheduled ingest failures are reported and do not produce unhandled rejections', async () => {
  const failure = new Error('Ingest unavailable')
  vi.spyOn(sink, 'submit').mockRejectedValueOnce(failure)
  await play()
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure)
  expect(events()).toHaveLength(createScenario(schedulerStart).length + 3 + SCENARIO_JOB_EVENTS)
  expect(scheduler.pending).toBe(0)
})

test('speed scales timer delays while scenario data stays deterministic', async () => {
  port = createHermesPort(loadConfig({ SCORE_FAKE_SPEED: '100', SCORE_FAKE_LOOP: 'false' }), {
    scheduler,
    onError,
  })
  await port.start(sink)
  await scheduler.advance(scenarioDuration / 100 - 1)
  expect(events().at(-1)?.type).toBe('agent.updated')
  await scheduler.advance(1)
  expect(events()).toHaveLength(createScenario(schedulerStart).length + 4 + SCENARIO_JOB_EVENTS)
  expect(events().at(-1)?.data).toMatchObject({ updatedAt: '2026-01-01T12:03:00.000Z' })
})

test('overdue timers cannot reorder scripted events or skip the running transition', async () => {
  await port.start(sink)
  const { runId } = await port.startRun({
    agentId: 'lead',
    input: 'Summarize the feed',
    turnId: 'late-turn',
  })
  await scheduler.advance(scenarioDuration, true)
  const stored = events()
  expect(
    stored
      .filter((event) => event.type === 'run.updated' && event.data.id === runId)
      .map((event) => event.data),
  ).toMatchObject([{ status: 'queued' }, { status: 'running' }, { status: 'completed' }])
  expect(
    stored
      .filter(
        (event) =>
          event.type !== 'room.upserted' &&
          // The scenario room's job follows its messages (exchanges routing, 11.11).
          event.type !== 'job.upserted' &&
          // The run's own tool frames (neutral demo content) are not part of the script.
          !(event.type === 'watch.frame' && event.data.runId === runId) &&
          !(event.type === 'run.updated' && event.data.id === runId),
      )
      .map((event) => event.type),
  ).toEqual(
    createScenario(schedulerStart)
      .map((step) => step.kind)
      .filter((kind) => kind !== 'room.upserted'),
  )
})

test('looping pauses ten seconds then emits fresh identities and entities on the same ingest log', async () => {
  port = createHermesPort(loadConfig({}), { scheduler, onError })
  await play()
  const first = events()
  expect(first).toHaveLength(createScenario(schedulerStart).length + 4 + SCENARIO_JOB_EVENTS)
  expect(scheduler.pending).toBe(1)
  await scheduler.advance(9999)
  expect(events()).toEqual(first)
  await scheduler.advance(1 + scenarioDuration)
  const second = events().slice(first.length)
  expect(second).toHaveLength(first.length)
  expect(new Set(observations.map(({ identity }) => identity)).size).toBe(
    createScenario(schedulerStart).length * 2,
  )
  const session = observations[0]!.identity.split(':')[0]
  expect(observations[createScenario(schedulerStart).length]!.identity).toBe(`${session}:1:0`)
  const entityIds = (loopEvents: StreamEvent[]) =>
    new Set(
      loopEvents.flatMap((event) =>
        ['run.updated', 'task.upserted', 'approval.requested', 'message.created'].includes(
          event.type,
        ) && 'id' in event.data
          ? [event.data.id]
          : [],
      ),
    )
  const firstIds = entityIds(first)
  const secondIds = entityIds(second)
  expect([...secondIds].every((id) => !firstIds.has(id))).toBe(true)
  expect(second.map(({ type }) => type)).toEqual(first.map(({ type }) => type))
  expect(second.find((event) => event.type === 'message.delta')?.data.messageId).toBe(
    'message-plan-1',
  )
  expect(second.find((event) => event.type === 'run.updated')?.data.refs).toEqual([
    { kind: 'task', taskId: 'task-pagination-1' },
  ])
  expect(results.every((result) => result.status === 'applied')).toBe(true)
  expect(onError).not.toHaveBeenCalled()
  await scheduler.advance(10000 + scenarioDuration)
  expect(observations[createScenario(schedulerStart).length * 2]!.identity).toBe(`${session}:2:0`)
  await port.stop()
  expect(scheduler.pending).toBe(0)
})

test('SCORE_FAKE_LOOP=false idles after a three-minute scenario with distinct realistic approval commands', async () => {
  await play()
  const stored = events()
  expect(scheduler.pending).toBe(0)
  await scheduler.advance(scenarioDuration * 3)
  expect(events()).toEqual(stored)
  const approvals = stored.filter((event) => event.type === 'approval.requested')
  expect(new Set(approvals.map((event) => event.data.command)).size).toBe(4)
  expect(new Set(approvals.map((event) => event.data.title)).size).toBe(4)
  expect(createScenario(schedulerStart).at(-1)?.at).toBe(scenarioDuration)
})
