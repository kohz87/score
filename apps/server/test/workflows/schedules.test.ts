import { ORCH_ACKNOWLEDGEMENT_TEXT, type RecipeScheduleRequest } from '@score/contract'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { recipeSchedule, setRecipeSchedule } from '../../src/domain/recipe-schedules.ts'
import { repeatingRunner } from '../../src/domain/repeating-runner.ts'
import { stepTuning } from '../../src/domain/workflows/step-tuning.ts'
import {
  agent,
  definition,
  edge,
  end,
  incarnationOf,
  replaceAgent,
  save,
  seedAgent,
  wfHarness,
  type Harness,
} from './wf-harness.ts'

// Decision 183: a recipe repeats on a schedule Score runs, bound to what the person saw when setting it.
let h: Harness
const now = () => new Date(h.scheduler.now()).toISOString()

beforeEach(async () => {
  h = await wfHarness()
  seedAgent(h, 'builder')
  h.db.tx((sqlite) =>
    sqlite
      .prepare(
        `INSERT INTO rooms (id, name, kind, members, created_at, updated_at, role, routing)
         VALUES ('release', '#release', 'room', '["lead","builder"]', ?, ?, 'room', 'exchanges')`,
      )
      .run(now(), now()),
  )
})
afterEach(async () => {
  await h.close()
})

const recipe = (over: Parameters<typeof agent>[1] = {}) =>
  save(h, definition([agent('draft', over), end()], [edge('draft', 'done')]))
const request = (over: Partial<RecipeScheduleRequest> = {}): RecipeScheduleRequest => ({
  schedule: 'every 1h',
  timezone: 'UTC',
  roomId: 'release',
  enabled: true,
  agentMap: [{ agentId: 'builder', incarnation: incarnationOf(h, 'builder') }],
  acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
  ...over,
})
const runner = () =>
  repeatingRunner({
    orchestrator: h.orch,
    db: h.db,
    ingest: h.ingest,
    port: h.port,
    clock: () => h.scheduler.now(),
  })

test('a due fire starts one run as a job in the schedule’s chat, and the schedule moves on', async () => {
  const id = recipe()
  const set = h.db.tx((sqlite) => setRecipeSchedule(sqlite, id, request(), now()))
  expect(set).toMatchObject({ enabled: true, roomName: '#release', lastRun: null })
  await h.scheduler.advance(3_600_000)
  await runner().tick()
  const after = h.db.read((sqlite) => recipeSchedule(sqlite, id))!
  expect(after.lastRun).toMatchObject({ outcome: 'started' })
  expect(after.lastRun?.briefId).toBeTruthy()
  expect(Date.parse(after.nextRunAt!)).toBeGreaterThan(h.scheduler.now())
  const topics = h.db.sqlite
    .prepare("SELECT title FROM jobs WHERE room_id = 'release' AND is_default = 0")
    .all() as { title: string }[]
  expect(topics).toHaveLength(1)
  expect(topics[0]!.title).toMatch(/^Test workflow · /)
})

test('a fire found late (Score wasn’t running) is recorded as missed and not run', async () => {
  const id = recipe()
  h.db.tx((sqlite) => setRecipeSchedule(sqlite, id, request(), now()))
  await h.scheduler.advance(3_600_000 + 10 * 60_000)
  await runner().tick()
  expect(h.db.read((sqlite) => recipeSchedule(sqlite, id))!.lastRun).toMatchObject({
    outcome: 'missed',
    briefId: null,
  })
  expect(
    h.db.sqlite.prepare("SELECT 1 FROM jobs WHERE room_id = 'release' AND is_default = 0").all(),
  ).toEqual([])
})

test('an agent replaced since the schedule was set makes that run fail with the reason', async () => {
  const id = recipe()
  h.db.tx((sqlite) => setRecipeSchedule(sqlite, id, request(), now()))
  replaceAgent(h, 'builder')
  await h.scheduler.advance(3_600_000)
  await runner().tick()
  expect(h.db.read((sqlite) => recipeSchedule(sqlite, id))!.lastRun).toMatchObject({
    outcome: 'failed',
    reason: expect.stringContaining('builder changed'),
  })
})

test('a recipe that asks for inputs, or a schedule that never fires, can’t repeat', () => {
  const asks = save(
    h,
    definition(
      [agent('draft'), end()],
      [edge('draft', 'done')],
      [{ name: 'topic', label: 'Topic', required: true, maxChars: 100 }],
    ),
  )
  expect(() => h.db.tx((sqlite) => setRecipeSchedule(sqlite, asks, request(), now()))).toThrow(
    /asks for inputs/,
  )
  const id = recipe()
  expect(() =>
    h.db.tx((sqlite) => setRecipeSchedule(sqlite, id, request({ schedule: '0 0 31 2 *' }), now())),
  ).toThrow(/never fires/)
})

test('a step’s own model and effort reach its run; a step without them sends none', async () => {
  const id = recipe({ model: { model: 'deep-model', provider: 'local' }, effort: 'high' })
  h.db.tx((sqlite) => setRecipeSchedule(sqlite, id, request(), now()))
  await h.scheduler.advance(3_600_000)
  await runner().tick()
  const step = h.db.sqlite.prepare('SELECT orchestration_id, step_id FROM wf_steps').get() as {
    orchestration_id: string
    step_id: string
  }
  expect(stepTuning(h.db.sqlite, step.orchestration_id, step.step_id)).toEqual({
    model: 'deep-model',
    provider: 'local',
    effort: 'high',
  })
  expect(stepTuning(h.db.sqlite, step.orchestration_id, 'no-such-step')).toEqual({})
})
