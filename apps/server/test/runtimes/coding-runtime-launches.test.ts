import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { migrate, openDatabase } from '../../src/db/index.ts'
import {
  addAgent,
  boot,
  calls,
  coding,
  db,
  dir,
  finished,
  ingest,
  launchedTurns,
  launches,
  makeRoom,
  pidAlive,
  replies,
  request,
  runs,
  say,
  setupCodingRuntime,
  spawned,
} from './coding-runtime-helpers.ts'

setupCodingRuntime()

test('0052 widens the runtime list and keeps every coding agent row', () => {
  const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url))
  const before = join(dir, 'before-0052')
  mkdirSync(before)
  for (const name of readdirSync(migrations))
    if (Number(name.slice(0, 4)) < 52) copyFileSync(join(migrations, name), join(before, name))
  const old = openDatabase(join(dir, 'old.db'))
  migrate(old, before)
  const at = '2026-10-10T10:00:00.000Z'
  old.sqlite
    .prepare(
      "INSERT INTO coding_agents (id, name, runtime, workspace, permission, color, shape, confirmed_version, created_at, removed_at) VALUES ('c1', 'C', 'codex', '/w', 'read-only', '#000000', 'hexagon', '0.1.0', ?, ?)",
    )
    .run(at, at)
  expect(() =>
    old.sqlite
      .prepare(
        "INSERT INTO coding_agents (id, name, runtime, workspace, permission, color, shape, created_at) VALUES ('a1', 'A', 'antigravity', '/w', 'read-only', '#000000', 'hexagon', ?)",
      )
      .run(at),
  ).toThrow()
  migrate(old, migrations)
  old.sqlite
    .prepare(
      "INSERT INTO coding_agents (id, name, runtime, workspace, permission, color, shape, created_at) VALUES ('a1', 'A', 'antigravity', '/w', 'read-only', '#000000', 'hexagon', ?)",
    )
    .run(at)
  expect(
    old.sqlite
      .prepare('SELECT id, runtime, confirmed_version, removed_at FROM coding_agents ORDER BY id')
      .all(),
  ).toEqual([
    { id: 'a1', runtime: 'antigravity', confirmed_version: null, removed_at: null },
    { id: 'c1', runtime: 'codex', confirmed_version: '0.1.0', removed_at: at },
  ])
  old.close()
})

// The fake CLI logs every start; a version probe has an empty prompt, a launched turn has its prompt.

test('S2-006: the admitted model reaches the CLI and the run row, even if the default changes while queued', async () => {
  await addAgent({ model: 'model-a' })
  await makeRoom()
  await coding.startRun({ agentId: 'coder', input: '[fixture:slow] hold', turnId: 't-first' })
  const second = await coding.startRun({
    agentId: 'coder',
    input: 'go',
    turnId: 't-second',
    model: 'model-b',
  })
  expect(
    (await request('PATCH', '/api/coding-agents/coder', { model: 'model-c' })).statusCode,
  ).toBe(200)
  const row = () =>
    db.sqlite.prepare('SELECT model, status FROM runs WHERE id = ?').get(second.runId) as {
      model: string
      status: string
    }
  expect(row()).toMatchObject({ model: 'model-b', status: 'queued' })
  await coding.stopRun({ agentId: 'coder', runId: runs()[0]!.id })
  await vi.waitFor(() => expect(row().status).toBe('completed'), { timeout: 20_000 })
  const argv = calls().map((call) => call.args)
  const flagged = argv.filter((args) => args.includes('--model'))
  // The first turn ran with the default at its time, the second with what was admitted.
  expect(flagged.map((args) => args[args.indexOf('--model') + 1])).toEqual(['model-a', 'model-b'])
  // (The CLI's own init event later reports the model it really used, so the row is checked while queued.)
})

test('S2-007: Stop while the CLI check is awaited never launches the turn', async () => {
  await addAgent()
  const realDetect = coding.locator.detect.bind(coding.locator)
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let held = false
  vi.spyOn(coding.locator, 'detect').mockImplementation(async (driver, options) => {
    // The fresh read right before a launch is the one held.
    if (options?.fresh && !held) {
      held = true
      await gate
    }
    return realDetect(driver, options)
  })
  const { runId } = await coding.startRun({ agentId: 'coder', input: 'go', turnId: 't-stop-1' })
  await vi.waitFor(() => expect(held).toBe(true))
  await coding.stopRun({ agentId: 'coder', runId })
  release()
  await vi.waitFor(
    () =>
      expect(
        (db.sqlite.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string })
          .status,
      ).toBe('cancelled'),
    { timeout: 10_000 },
  )
  expect(launches).toBe(0)
  expect(launchedTurns('go')).toEqual([])
})

test('S2-007: Stop while the running observation is awaited never launches the turn', async () => {
  await addAgent()
  const realSubmit = ingest.submit.bind(ingest)
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let held = false
  vi.spyOn(ingest, 'submit').mockImplementation(async (observation) => {
    if (observation.identity.includes(':running') && !held) {
      held = true
      await gate
    }
    return realSubmit(observation)
  })
  const { runId } = await coding.startRun({ agentId: 'coder', input: 'go', turnId: 't-stop-2' })
  await vi.waitFor(() => expect(held).toBe(true))
  await coding.stopRun({ agentId: 'coder', runId })
  release()
  await vi.waitFor(
    () =>
      expect(
        (db.sqlite.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string })
          .status,
      ).toBe('cancelled'),
    { timeout: 10_000 },
  )
  expect(launches).toBe(0)
  expect(launchedTurns('go')).toEqual([])
})

test('S2-008: a failed terminal save is retried without launching the CLI again', async () => {
  await addAgent()
  await makeRoom()
  const realSubmit = ingest.submit.bind(ingest)
  let rejected = 0
  vi.spyOn(ingest, 'submit').mockImplementation(async (observation) => {
    if (observation.identity.endsWith(':terminal') && rejected < 2) {
      rejected++
      throw new Error('database is busy')
    }
    return realSubmit(observation)
  })
  await say('@coder go')
  await finished()
  expect(rejected).toBe(2)
  expect(launches).toBe(1)
  expect(runs()[0]).toMatchObject({ status: 'completed' })
  expect(replies()[0]!.streaming).toBe(false)
})

const savedOutput = () =>
  (db.sqlite.prepare('SELECT output FROM runs').get() as { output: string }).output
const pendingRows = () =>
  db.sqlite.prepare('SELECT run_id FROM coding_pending_terminals').all().length
const recordRows = () => db.sqlite.prepare('SELECT run_id FROM coding_processes').all().length

test('S3-004: a result that cannot be saved is kept and saved once ingestion recovers, without relaunching', async () => {
  await addAgent()
  await makeRoom()
  const realSubmit = ingest.submit.bind(ingest)
  const errors: unknown[] = []
  ;(coding as unknown as { deps: { onError?: (e: unknown) => void } }).deps.onError = (e) =>
    errors.push(e)
  let failing = true
  let terminalTries = 0
  vi.spyOn(ingest, 'submit').mockImplementation(async (observation) => {
    // Every terminal write fails, normal or degraded.
    if (failing && observation.identity.includes(':terminal')) {
      terminalTries++
      throw new Error('database is busy')
    }
    return realSubmit(observation)
  })
  await say('@coder go')
  await vi.waitFor(() => expect(terminalTries).toBeGreaterThan(6), { timeout: 15_000 })
  // Past the retry budget: still not abandoned, not a silent success, record and process evidence kept.
  expect(pendingRows()).toBe(1)
  expect(recordRows()).toBe(1)
  expect(runs()[0]!.status).not.toBe('completed')
  expect(errors.length).toBeGreaterThan(0)
  failing = false
  await finished()
  expect(runs()[0]).toMatchObject({ status: 'completed' })
  expect(launches).toBe(1)
  expect(replies()[0]!.streaming).toBe(false)
  expect(savedOutput()).toBeTruthy()
  expect(JSON.stringify(replies()[0]!.parts)).toContain(savedOutput())
  expect(pendingRows()).toBe(0)
  expect(recordRows()).toBe(0)
})

test('review #7: a pending terminal record never holds unredacted free text on disk', async () => {
  await addAgent()
  await makeRoom()
  const realSubmit = ingest.submit.bind(ingest)
  let terminalTries = 0
  vi.spyOn(ingest, 'submit').mockImplementation(async (observation) => {
    if (observation.identity.includes(':terminal')) {
      terminalTries++
      throw new Error('database is busy')
    }
    return realSubmit(observation)
  })
  await say('@coder [fixture:secret] go')
  await vi.waitFor(() => expect(terminalTries).toBeGreaterThan(0), { timeout: 15_000 })
  const stored = JSON.stringify(db.sqlite.prepare('SELECT * FROM coding_pending_terminals').all())
  expect(stored).toContain('The key is')
  expect(stored).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  expect(stored).toContain('[redacted]')
})

test('S3-004: a success still pending when Score restarts is interrupted, never promoted (review #13)', async () => {
  await addAgent()
  await makeRoom()
  const realSubmit = ingest.submit.bind(ingest)
  let terminalTries = 0
  vi.spyOn(ingest, 'submit').mockImplementation(async (observation) => {
    if (observation.identity.includes(':terminal')) {
      terminalTries++
      throw new Error('database is busy')
    }
    return realSubmit(observation)
  })
  await say('@coder go')
  await vi.waitFor(() => expect(terminalTries).toBeGreaterThan(6), { timeout: 15_000 })
  expect(pendingRows()).toBe(1)
  await coding.close()
  vi.restoreAllMocks()
  await boot()
  await coding.recover()
  await ingest.flushListeners()
  await ingest.drain()
  // Review 2026-10-12 #13: a pending success is a candidate only; after a restart it is interrupted, never promoted.
  expect(runs()[0]).toMatchObject({ status: 'interrupted' })
  expect(
    db.sqlite.prepare("SELECT 1 FROM message_runs WHERE from_agent_id = 'coder'").all(),
  ).toEqual([])
  expect(launches).toBe(1)
  expect(replies()[0]!.streaming).toBe(false)
  expect(pendingRows()).toBe(0)
  expect(recordRows()).toBe(0)
})

test('S2-004: when recording the process fails, the child is killed and the run ends visibly', async () => {
  await addAgent()
  await makeRoom()
  // A real database failure: the process record can't be inserted.
  db.sqlite.exec(
    "CREATE TRIGGER no_records BEFORE INSERT ON coding_processes BEGIN SELECT RAISE(ABORT, 'database is busy'); END",
  )
  await say('@coder [fixture:slow] go')
  await finished()
  expect(runs()[0]).toMatchObject({ status: 'failed' })
  expect(runs()[0]!.error).toMatch(/Could not prepare the run/)
  expect(spawned).toHaveLength(1)
  await vi.waitFor(() => expect(pidAlive(spawned[0]!)).toBe(false), { timeout: 10_000 })
  expect(replies()[0]!.streaming).toBe(false)
})

// ---- Fix batch W: the runtime claims a process ended only when it can prove it. ----
