import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { verifyCoding } from '../../src/domain/orchestration/coding-checkpoint.ts'
import {
  addAgent,
  afterEachHarness,
  app,
  backend,
  beforeEachHarness,
  boot,
  coding,
  db,
  fake,
  journal,
  journalKinds,
  launchRow,
  request,
  rebootWithKill,
  runRow,
  seedLaunch,
  seedRun,
} from './coding-units-runtime-helpers.ts'

beforeEach(beforeEachHarness)
afterEach(afterEachHarness)

// ---- recovery: journal <-> database <-> units <-> receipts -------------------------------------------------------------

test('recovery: a launch that never reached releasing is revoked by the journal alone; the run is interrupted', async () => {
  await addAgent()
  const seed = seedLaunch('requested')
  expect(await coding.recover()).toBe(1)
  expect(runRow(seed.runId)).toMatchObject({ status: 'interrupted' })
  expect(launchRow(seed.launchId)).toMatchObject({
    revoked: 1,
    may_have_executed: 0,
    phase: 'settled',
    held: 0,
  })
  expect(journalKinds(seed.launchId)).toEqual(['launch-requested', 'revoked', 'ended', 'settled'])
})

test('recovery: an armed launch with a live unit is revoked and its supervisor stopped through its pinned identity', async () => {
  await addAgent()
  const seed = seedLaunch('armed', { withUnit: true })
  await coding.recover()
  expect(fake.units.has(seed.unit)).toBe(false)
  expect(launchRow(seed.launchId)).toMatchObject({
    revoked: 1,
    may_have_executed: 0,
    phase: 'settled',
  })
  // The stop went to the recorded supervisor (pid + start), never to the unit by name (re-review #5).
  expect(fake.signals.filter((s) => s.delivered)).toEqual([
    { pid: seed.live!.pid, start: seed.live!.start, signal: 'SIGINT', delivered: true },
  ])
  expect(fake.calls.filter((c) => c.includes('stop'))).toEqual([])
})

test('recovery: a released launch with a live unit is stopped, proven ended and settled; released-seen needs the receipt', async () => {
  await addAgent()
  const seen = seedLaunch('releasing', { withUnit: true, receipts: ['released.json'] })
  const unseen = seedLaunch('releasing', { withUnit: true })
  await coding.recover()
  expect(runRow(seen.runId)).toMatchObject({ status: 'interrupted' })
  expect(launchRow(seen.launchId)).toMatchObject({
    phase: 'settled',
    may_have_executed: 1,
    held: 0,
  })
  expect(journalKinds(seen.launchId)).toEqual([
    'launch-requested',
    'armed',
    'releasing',
    'released-seen',
    'ended',
    'settled',
  ])
  expect(journalKinds(unseen.launchId)).toEqual([
    'launch-requested',
    'armed',
    'releasing',
    'ended',
    'settled',
  ])
  expect(fake.units.size).toBe(0)
})

test('recovery: a run whose result was saved but whose launch was never settled is settled now', async () => {
  await addAgent()
  const seed = seedLaunch('releasing', { runStatus: 'completed' })
  await coding.recover()
  expect(runRow(seed.runId).status).toBe('completed')
  expect(launchRow(seed.launchId)).toMatchObject({ phase: 'settled' })
})

test('recovery: a database that lost the launch row (an older backup) is rebuilt from the journal', async () => {
  await addAgent()
  const seed = seedLaunch('releasing')
  db.sqlite.prepare('DELETE FROM coding_launches WHERE launch_id = ?').run(seed.launchId)
  await coding.recover()
  expect(launchRow(seed.launchId)).toMatchObject({
    backend: 'unit',
    phase: 'settled',
    may_have_executed: 1,
  })
})

test('recovery: may have executed and not provable is unconfirmed, holds the agent, and a later proof releases it', async () => {
  await coding.close()
  await app.close()
  await boot({ unit: { recoverProofMs: 300 }, reapRetryMs: 30 })
  await addAgent()
  fake.hooks.ignoreStop = true
  const seed = seedLaunch('releasing', { withUnit: true })
  await coding.recover()
  expect(runRow(seed.runId)).toMatchObject({
    status: 'interrupted',
    terminal_source: 'unconfirmed',
  })
  expect(runRow(seed.runId).error).toMatch(/Some of its tools may still be running/)
  expect(launchRow(seed.launchId)).toMatchObject({ held: 1, phase: 'releasing' })
  const refused = await coding
    .startRun({ agentId: 'coder', input: 'go', turnId: 't-held' })
    .catch((error: unknown) => error)
  expect(refused).toMatchObject({ status: 422, code: 'agent_still_stopping' })
  const view = (await request('GET', '/api/coding-agents')).json().items[0]
  expect(view.heldGroups).toEqual([
    { runId: seed.runId, pgid: 0, canRelease: false, unit: seed.unit },
  ])
  // The unit finally obeys: the background loop proves it ended and the agent is free again.
  fake.hooks.ignoreStop = false
  await vi.waitFor(
    () => expect(launchRow(seed.launchId)).toMatchObject({ phase: 'settled', held: 0 }),
    {
      timeout: 15_000,
    },
  )
  expect((await request('GET', '/api/coding-agents')).json().items[0].heldGroups).toEqual([])
})

test('recovery: systemd that cannot be read holds every open launch and the person may release them', async () => {
  await coding.close()
  await app.close()
  await boot({ unit: { recoverProofMs: 200 }, reapRetryMs: 30 })
  await addAgent()
  const seed = seedLaunch('releasing', { withUnit: true })
  fake.hooks.showFails = true
  await coding.recover()
  expect(runRow(seed.runId)).toMatchObject({
    status: 'interrupted',
    terminal_source: 'unconfirmed',
  })
  await vi.waitFor(
    async () => {
      const held = (await request('GET', '/api/coding-agents')).json().items[0].heldGroups
      expect(held).toEqual([{ runId: seed.runId, pgid: 0, canRelease: true, unit: seed.unit }])
    },
    { timeout: 15_000 },
  )
  fake.hooks.showFails = false
  const signalsBefore = fake.signals.length
  const released = await request('POST', '/api/coding-agents/coder/release', {})
  expect(released.statusCode, released.body).toBe(200)
  const row = launchRow(seed.launchId)
  expect(row.held).toBe(0)
  // The projection is the journal's: a waiver is not an ended proof (re-review 2 #16).
  expect(row.proof).toBeNull()
  // ... and the journal and the database agree on it: nothing for the next start to fence (re-review 2 #16).
  const read = journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  expect(verifyCoding(db.sqlite, read.entries)).toEqual([])
  expect(db.sqlite.prepare('SELECT agent_id, run_id FROM coding_releases').all()).toEqual([
    { agent_id: 'coder', run_id: seed.runId },
  ])
  // Nothing was signalled by the release itself, and the journal says the launch is settled as waived.
  expect(fake.signals.length).toBe(signalsBefore)
  expect(row.disposition).toBe('waived')
  expect(journalKinds(seed.launchId).at(-1)).toBe('waived') // Release is a waiver record, phase settled
})

test('recovery: after a manager cold restart the receipts and the recorded cgroup decide, never missing metadata', async () => {
  await coding.close()
  await app.close()
  await boot({ unit: { population: () => 'unknown', recoverProofMs: 200 }, reapRetryMs: 5_000 })
  await addAgent()
  // The unit is gone and the cgroup cannot be read: the supervisor's own `ended` receipt (written only once the
  // payload was empty) is the witness.
  const old = `${fake.boot}|1111:5`
  const witnessed = seedLaunch('releasing', {
    manager: old,
    receipts: ['released.json', 'ended.json'],
  })
  const unwitnessed = seedLaunch('releasing', { manager: old, receipts: ['released.json'] })
  // The same manager with the unit missing and the cgroup unreadable is NOT enough: missing metadata proves nothing.
  const sameManager = seedLaunch('releasing', { receipts: ['released.json', 'ended.json'] })
  await coding.recover()
  expect(launchRow(witnessed.launchId)).toMatchObject({
    phase: 'settled',
    proof: 'receipt',
    held: 0,
  })
  expect(launchRow(unwitnessed.launchId)).toMatchObject({ phase: 'releasing', held: 1 })
  expect(runRow(unwitnessed.runId).terminal_source).toBe('unconfirmed')
  expect(launchRow(sameManager.launchId)).toMatchObject({ phase: 'releasing', held: 1 })
})

test('recovery: a changed boot means everything ended', async () => {
  await coding.close()
  await app.close()
  await boot({ unit: { population: () => 'unknown' } })
  await addAgent()
  const seed = seedLaunch('releasing', { manager: 'boot-OLD|99:5' })
  await coding.recover()
  expect(launchRow(seed.launchId)).toMatchObject({ phase: 'settled', proof: 'boot-change' })
})

test('recovery: a unit with this installation’s prefix and no journal launch is an orphan: never adopted, admission paused', async () => {
  const orphans: string[][] = []
  await coding.close()
  await app.close()
  await boot({ onOrphans: (names) => orphans.push(names) })
  await addAgent()
  const stray = fake.addUnit('score-abcdef01-c-deadbeefdeadbeefdeadbeefdeadbeef.service')
  await coding.recover()
  expect(orphans).toEqual([[stray.name]])
  // Not stopped, not adopted.
  expect(fake.units.has(stray.name)).toBe(true)
  expect(fake.calls.some((c) => c.includes('stop') && c.includes(stray.name))).toBe(false)
  const refused = await coding
    .startRun({ agentId: 'coder', input: 'go', turnId: 't-orphan' })
    .catch((error: unknown) => error)
  expect(refused).toMatchObject({ status: 422, code: 'coding_paused' })
  expect(backend.orphaned).toEqual([stray.name])
  // The person removes the stray service and presses Check again: admission resumes.
  fake.forget(stray.name)
  await request('POST', '/api/coding-agents/backend/check', {})
  expect(backend.orphaned).toEqual([])
  expect(backend.block()).toBeNull()
})

test('recovery: both backends are reconciled after an upgrade (a recorded process group and a unit launch)', async () => {
  await coding.close()
  await app.close()
  const asked: number[] = []
  await rebootWithKill(async (record) => {
    asked.push(record.pid)
    return 'gone' as const
  })
  await addAgent()
  seedRun('cr_oldstyle')
  db.sqlite
    .prepare(
      `INSERT INTO coding_processes (run_id, pid, pgid, start_time, boot_id, created_at) VALUES ('cr_oldstyle', 4000001, 4000001, '5', 'b', ?)`,
    )
    .run(new Date().toISOString())
  const seed = seedLaunch('releasing', { withUnit: true })
  expect(await coding.recover()).toBe(2)
  expect(asked).toEqual([4000001])
  expect(runRow('cr_oldstyle').status).toBe('interrupted')
  expect(runRow(seed.runId).status).toBe('interrupted')
  expect(launchRow(seed.launchId).phase).toBe('settled')
  expect(db.sqlite.prepare('SELECT run_id FROM coding_processes').all()).toEqual([])
})

// ---- review fixes FX4 (#5, #9, #14) ----------------------------------------------------------------------------------

test('#9: recovery never stops a unit it did not verify: an unarmed launch has no recorded invocation to match', async () => {
  await addAgent()
  // A launch that never armed, while a unit with its name is running: Score cannot tell whose invocation that is.
  const seed = seedLaunch('requested', { withUnit: true })
  await coding.recover()
  expect(fake.calls.some((c) => c.includes('stop') && c.includes(seed.unit))).toBe(false)
  expect(fake.units.get(seed.unit)?.active).toBe('active')
  // Unresolved, not guessed: the launch is held and the person may release it.
  expect(launchRow(seed.launchId).held).toBeGreaterThan(0)
  expect(launchRow(seed.launchId).phase).not.toBe('settled')
})

test('#9: an unarmed launch whose unit is gone is still proven to have never started', async () => {
  await addAgent()
  const seed = seedLaunch('requested')
  expect(await coding.recover()).toBe(1)
  expect(launchRow(seed.launchId)).toMatchObject({ phase: 'settled', held: 0 })
})
