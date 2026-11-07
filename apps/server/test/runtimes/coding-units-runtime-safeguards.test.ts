import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { CodingJournal } from '../../src/domain/orchestration/coding-journal.ts'
import {
  addAgent,
  afterEachHarness,
  app,
  backend,
  beforeEachHarness,
  boot,
  cliCalls,
  coding,
  db,
  fake,
  finished,
  journalKinds,
  launchRow,
  launches,
  makeRoom,
  processLaunches,
  request,
  runs,
  say,
  seedLaunch,
  setEnv,
} from './coding-units-runtime-helpers.ts'

beforeEach(beforeEachHarness)
afterEach(afterEachHarness)

test('#5: a fence raised while the unit starts stops the release: the CLI never runs', async () => {
  let fenced = false
  await coding.close()
  await app.close()
  await boot({ blocked: () => (fenced ? 'Score is waiting for you to review the journal.' : null) })
  await addAgent()
  await makeRoom()
  fake.hooks.afterStart = () => {
    fenced = true
  }
  await say('@coder [fixture:basic] go')
  await finished()
  expect(cliCalls()).toHaveLength(0)
  const [launch] = launches()
  expect(launch).toMatchObject({ revoked: 1, may_have_executed: 0 })
  expect(journalKinds(launch!.launch_id)).not.toContain('releasing')
})

test('#5: a disabled backend (forced fallback) still reconciles units and enforces the barriers', async () => {
  await coding.close()
  await app.close()
  fake.calls.length = 0
  await boot({ unit: { disabled: 'The fallback is forced.', forced: true } })
  expect(backend.status.kind).toBe('process-group')
  expect(backend.status.note).toContain('The fallback is forced.')
  expect(backend.usable()).toBe(false)
  await addAgent()
  const stray = fake.addUnit('score-abcdef01-c-deadbeefdeadbeefdeadbeefdeadbeef.service')
  await coding.recover()
  // The orphan inventory ran although nothing is supervised, and the barrier answers.
  expect(backend.orphaned).toEqual([stray.name])
  expect(backend.block()).toMatch(/isn’t accounted for/)
  // A disabled backend runs no capability probe and starts nothing.
  expect(fake.calls.some((c) => c[0]!.endsWith('systemd-run'))).toBe(false)
})

test('#5: an unresolved installation reconciles nothing and keeps the barrier up', async () => {
  await coding.close()
  await app.close()
  await boot({
    unit: { disabled: 'This installation isn’t resolved yet.', unresolved: true },
    blocked: () => 'The installation isn’t resolved.',
  })
  const stray = fake.addUnit('score-00000000-c-deadbeefdeadbeefdeadbeefdeadbeef.service')
  expect(await backend.recover()).toEqual({ launches: [], orphans: [], unreadable: null })
  expect(backend.block()).toBe('The installation isn’t resolved.')
  expect(fake.calls.some((c) => c.includes('stop') && c.includes(stray.name))).toBe(false)
})

test('#8 reader: an empty, truncated, foreign or wrong-kind receipt is never proof', async () => {
  await coding.close()
  await app.close()
  await boot({ unit: { population: () => 'unknown', recoverProofMs: 200 }, reapRetryMs: 5_000 })
  await addAgent()
  const old = `${fake.boot}|1111:5`
  const mk = (ended: string) =>
    seedLaunch('releasing', {
      manager: old,
      receipts: ['released.json', 'ended.json'],
      bodies: { 'ended.json': ended },
    })
  const good = mk(
    JSON.stringify({ launch: 'x', generation: 0, at: 1, code: 0, signal: null, stopCause: null }),
  )
  // `good` names the wrong launch: rebuild it properly below; the invalid ones must all stay held.
  const empty = mk('')
  const truncated = mk('{"launch":"')
  const array = mk('[]')
  const wrongKind = mk(JSON.stringify({ launch: 'x', generation: 0, at: 1, supervisorPid: 1 }))
  await coding.recover()
  for (const seed of [good, empty, truncated, array, wrongKind])
    expect(launchRow(seed.launchId)).toMatchObject({ phase: 'releasing', held: 1 })
})

test('#8 reader: an empty released receipt does not record released-seen', async () => {
  await addAgent()
  const seed = seedLaunch('releasing', {
    withUnit: true,
    bodies: { 'released.json': '' },
    receipts: ['released.json'],
  })
  await coding.recover()
  expect(launchRow(seed.launchId).phase).toBe('settled')
  expect(journalKinds(seed.launchId)).not.toContain('released-seen')
})

test('#8 reader: an unreadable manager identity is uncertain, not a changed incarnation', async () => {
  await coding.close()
  await app.close()
  await boot({
    unit: { population: () => 'unknown', recoverProofMs: 200, manager: async () => null },
    reapRetryMs: 5_000,
  })
  await addAgent()
  const seed = seedLaunch('releasing', {
    manager: `${fake.boot}|1111:5`,
    receipts: ['released.json', 'ended.json'],
  })
  await coding.recover()
  expect(launchRow(seed.launchId)).toMatchObject({ phase: 'releasing', held: 1 })
})

// The service must consult the barrier whichever backend launches: `service.ts` calls `unit.block()` only when
// `unit.usable()` (an FX2 file). This documents the gap; when service.ts calls block() unconditionally, delete `.fails`.
test('#5: the fallback launch is refused while a barrier is up (needs the service.ts change)', async () => {
  await coding.close()
  await app.close()
  await boot({
    unit: { disabled: 'The fallback is forced.' },
    blocked: () => 'Score is waiting for you to review the coding journal.',
  })
  await addAgent()
  const refused = await coding
    .startRun({ agentId: 'coder', input: 'go', turnId: 't-barrier' })
    .catch((error: unknown) => error)
  expect(refused).toMatchObject({ status: 422, code: 'coding_paused' })
})

// ---- second review round (FY1) ---------------------------------------------------------------------------------------

/** Everything Score stored about the runs, as one searchable string. */
function storedText(): string {
  const parts: string[] = []
  for (const table of ['runs', 'messages', 'coding_launches'])
    parts.push(JSON.stringify(db.sqlite.prepare(`SELECT * FROM ${table}`).all()))
  return parts.join('\n')
}

test('#3 (re-review): the eligibility note is redacted before it reaches SQLite', async () => {
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only')
  await addAgent({
    id: 'agy1',
    name: 'Agy',
    runtime: 'antigravity',
    permission: 'read-only',
    acknowledgeReads: true,
  })
  await makeRoom()
  await say('@agy1 [fixture:deniedsecret] go')
  await finished()
  expect(launches()[0]!.eligibility).toBeTruthy()
  expect(launches()[0]!.eligibility).not.toContain('review-sentinel')
  expect(storedText()).not.toContain('review-sentinel')
})

test('#4 (re-review): a long secret value on stderr never reaches the failure notice, the run or the launch row', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:stderrleak] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(runs()[0]!.error).toContain('ended without a result Score can use')
  expect(storedText()).not.toMatch(/v{20}/)
})

test('#3 (re-review): a record that cannot be validated after turn.completed still makes the result unusable', async () => {
  await addAgent({ id: 'cx', name: 'Cx', runtime: 'codex', acknowledgeReads: true })
  await makeRoom()
  await say('@cx [fixture:lateloss] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(runs()[0]!.error).toContain('without a result Score can use')
  expect(launches()[0]!.eligibility).toContain('could not validate')
})

test('#5 (re-review): a barrier raised after admission stops the fallback release: no releasing record, no CLI', async () => {
  let fenced = false
  await coding.close()
  await app.close()
  await boot({
    unit: { disabled: 'The fallback is forced.', forced: true },
    blocked: () => (fenced ? 'Score is waiting for you to review the coding journal.' : null),
    ingestWrap: (real) => ({
      submit: (observation) => {
        // The turn is admitted and goes `running`; the fence rises while it waits to be released.
        if (observation.identity.endsWith(':running')) fenced = true
        return real.submit(observation)
      },
    }),
  })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] go')
  await finished()
  expect(processLaunches).toBe(0)
  expect(cliCalls()).toHaveLength(0)
  // The process-group engine keeps no journal (decision 69): the barrier shows as no launch and a failed run.
  expect(runs()[0]!.status).toBe('failed')
})

test('#5 (re-review): recovery signals only the recorded supervisor; a foreign invocation under the same name is never stopped', async () => {
  await addAgent()
  // The recorded supervisor is gone; another invocation now occupies the unit name.
  const seed = seedLaunch('releasing', { receipts: ['released.json'] })
  const foreign = fake.addUnit(seed.unit)
  await coding.recover()
  expect(foreign.running).toBe(true)
  expect(fake.units.has(seed.unit)).toBe(true)
  expect(fake.calls.filter((c) => c.includes('stop'))).toEqual([])
  expect(fake.signals.every((s) => !s.delivered)).toBe(true)
  // Not proven ended (the name belongs to a different invocation): the agent stays held.
  expect(launchRow(seed.launchId)).toMatchObject({ held: expect.any(Number), phase: 'releasing' })
  expect(launchRow(seed.launchId).held).toBeGreaterThan(0)
})

test('#5 (re-review): a launch whose supervisor identity was never recorded is never stopped; it stays uncertain and releasable', async () => {
  await addAgent()
  const seed = seedLaunch('releasing', { withUnit: true, noIdentity: true })
  await coding.recover()
  expect(seed.live!.running).toBe(true)
  expect(fake.signals).toEqual([])
  expect(fake.calls.filter((c) => c.includes('stop'))).toEqual([])
  await vi.waitFor(() => expect(launchRow(seed.launchId).held).toBe(2), { timeout: 15_000 })
  expect(seed.live!.running).toBe(true)
})

test('#6 (re-review): the proof checks the recorded cgroup; a control group that disagrees proves nothing', async () => {
  await addAgent()
  const seed = seedLaunch('releasing', { withUnit: true, receipts: ['released.json'] })
  // systemd now names an empty, different control group for the unit while the recorded one is populated.
  seed.live!.controlGroup = '/fake/somewhere-else'
  seed.live!.active = 'inactive'
  const proof = await backend.proveEnded(seed.launchId, { timeoutMs: 200 })
  expect(proof.proven).toBe(false)
  expect(proof.detail).toMatch(/control group differs/)
})

test('#6 (re-review): the boot and the manager are kept beside the journal; a restored database that lost them still decides by the receipt', async () => {
  await coding.close()
  await app.close()
  await boot({ unit: { population: () => 'unknown', recoverProofMs: 200 }, reapRetryMs: 5_000 })
  await addAgent()
  const old = `${fake.boot}|1111:5`
  const seed = seedLaunch('releasing', { manager: old, receipts: ['released.json', 'ended.json'] })
  // The database lost its copy of the manager identity (an older backup).
  db.sqlite
    .prepare('UPDATE coding_launches SET manager = NULL WHERE launch_id = ?')
    .run(seed.launchId)
  await coding.recover()
  expect(launchRow(seed.launchId)).toMatchObject({ phase: 'settled', proof: 'receipt', held: 0 })
})

test('#6 (re-review): a recorded boot that differs means ended, and nothing is signalled', async () => {
  await addAgent()
  const seed = seedLaunch('releasing', { manager: 'boot-OLD|99:5' })
  await coding.recover()
  expect(launchRow(seed.launchId)).toMatchObject({ phase: 'settled', proof: 'boot-change' })
  expect(fake.signals).toEqual([])
})

test('#2 (re-review): a launch the journal does not own is never stopped, reset or settled', async () => {
  await addAgent()
  const seed = seedLaunch('releasing', { withUnit: true, receipts: ['released.json'] })
  vi.spyOn(CodingJournal.prototype, 'isOwned').mockReturnValue(false)
  await coding.recover()
  expect(seed.live!.running).toBe(true)
  expect(fake.signals).toEqual([])
  expect(fake.calls.filter((c) => c.includes('stop') || c.includes('reset-failed'))).toEqual([])
  expect(journalKinds(seed.launchId)).toEqual(['launch-requested', 'armed', 'releasing'])
})

test('#2 (re-review): a unit of another installation is never stopped or reset, whatever its journal record says', async () => {
  await addAgent()
  const other = 'score-11111111-c-deadbeefdeadbeefdeadbeefdeadbeef.service'
  const unit = fake.addUnit(other)
  // The unit-level stop and reset refuse a name outside the caller's prefix before looking at systemd.
  const { stopUnit, resetUnit } = await import('../../src/runtimes/coding/units.ts')
  fake.calls.length = 0
  expect(await stopUnit(fake.run, other, unit.invocationId, 'score-abcdef01-c-')).toBe('unknown')
  expect(await resetUnit(fake.run, other, unit.invocationId, 'score-abcdef01-c-')).toBe('unknown')
  expect(fake.calls).toEqual([])
})

test('#8 (re-review): Release settles the launch in the journal first; a restart never stops it again', async () => {
  await coding.close()
  await app.close()
  await boot({ unit: { recoverProofMs: 200 }, reapRetryMs: 30 })
  await addAgent()
  const seed = seedLaunch('releasing', { withUnit: true })
  fake.hooks.showFails = true
  await coding.recover()
  await vi.waitFor(
    async () =>
      expect((await request('GET', '/api/coding-agents')).json().items[0].heldGroups).toEqual([
        expect.objectContaining({ canRelease: true }),
      ]),
    { timeout: 15_000 },
  )
  const waive = vi.spyOn(CodingJournal.prototype, 'waive')
  expect((await request('POST', '/api/coding-agents/coder/release', {})).statusCode).toBe(200)
  expect(waive).toHaveBeenCalledWith(seed.launchId, expect.any(String), expect.anything())
  expect(journalKinds(seed.launchId).at(-1)).toBe('waived')
  const before = fake.signals.length
  fake.hooks.showFails = false
  await backend.recover()
  expect(fake.signals.length).toBe(before)
})
