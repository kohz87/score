import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CodingJournal } from '../../src/domain/orchestration/coding-journal.ts'
import { RunSession } from '../../src/runtimes/coding/coding-socket.ts'
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
  replies,
  runRow,
  runs,
  say,
  seedLaunch,
  textOf,
} from './coding-units-runtime-helpers.ts'

beforeEach(beforeEachHarness)
afterEach(afterEachHarness)

// ---- the ordering point ----------------------------------------------------------------------------------------------

test('Stop before the release revokes the launch: the CLI never runs and the journal says never ran', async () => {
  await addAgent()
  await makeRoom()
  fake.hooks.afterStart = () => {
    // The person presses Stop while the supervisor is still starting up.
    void coding.stopRun({ agentId: 'coder', runId: runs()[0]!.id })
  }
  await say('@coder [fixture:basic] go')
  await finished()
  expect(runs()[0]!.status).toBe('cancelled')
  expect(cliCalls()).toHaveLength(0)
  const [launch] = launches()
  expect(launch).toMatchObject({ revoked: 1, may_have_executed: 0, phase: 'settled', held: 0 })
  const kinds = journalKinds(launch!.launch_id)
  expect(kinds).toContain('revoked')
  expect(kinds).not.toContain('releasing')
  // No `released` receipt: the supervisor never started anything.
  expect(existsSync(join(launch!.receipt_dir!, 'released.json'))).toBe(false)
})

test('the run’s authorisation is re-evaluated inside the release critical section', async () => {
  await addAgent()
  await makeRoom()
  fake.hooks.afterStart = () => {
    // Another launch of this agent that cannot be proven ended: the agent is held, so this one must not be released.
    db.sqlite
      .prepare(
        `INSERT INTO coding_launches (launch_id, run_id, turn_id, generation, phase, revoked, may_have_executed,
           unit, backend, agent_id, held, journal_n, unsendable, updated_at)
         VALUES ('other', 'other-run', 't', 0, 'releasing', 0, 1, 'score-abcdef01-c-other.service', 'unit', 'coder', 1, 1, 1, ?)`,
      )
      .run(new Date().toISOString())
  }
  await say('@coder [fixture:basic] go')
  await finished()
  const mine = launches().find((l) => l.launch_id !== 'other')!
  expect(mine).toMatchObject({ revoked: 1, may_have_executed: 0 })
  expect(journalKinds(mine.launch_id)).not.toContain('releasing')
  expect(cliCalls()).toHaveLength(0)
})

test('an identity mismatch between the supervisor and systemd revokes the launch and stops the unit', async () => {
  await addAgent()
  await makeRoom()
  fake.hooks.mainPid = process.pid + 1
  await say('@coder [fixture:basic] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(runs()[0]!.error).toContain('identity')
  expect(cliCalls()).toHaveLength(0)
  const [launch] = launches()
  expect(launch).toMatchObject({ revoked: 1, may_have_executed: 0, phase: 'settled' })
  expect(fake.units.size).toBe(0)
})

test('systemd refusing to start the unit fails the turn without a CLI run and records a revoked launch', async () => {
  await addAgent()
  await makeRoom()
  fake.hooks.startFails = 'Failed to start transient service unit'
  await say('@coder [fixture:basic] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(runs()[0]!.error).toContain('refused to start')
  expect(cliCalls()).toHaveLength(0)
  expect(launches()[0]).toMatchObject({ revoked: 1, may_have_executed: 0, phase: 'settled' })
})

// ---- Stop, deadline, socket loss ---------------------------------------------------------------------------------------

test('Stop during a run goes through the protocol; the run is cancelled with ended proof and settled', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] take your time')
  await vi.waitFor(() => expect(runs()[0]?.status).toBe('running'), { timeout: 15_000 })
  await vi.waitFor(() => expect(replies()[0]?.parts.length).toBeGreaterThan(0), { timeout: 15_000 })
  const outcome = await coding.stopRun({ agentId: 'coder', runId: runs()[0]!.id })
  expect(outcome).toBe('stopped')
  await finished()
  expect(runs()[0]!.status).toBe('cancelled')
  expect(textOf(replies()[0])).toContain('This run was stopped.')
  const [launch] = launches()
  expect(launch).toMatchObject({ phase: 'settled', stop_cause: 'user', held: 0 })
  expect(journalKinds(launch!.launch_id)).toContain('releasing')
})

test('the wall-clock deadline is enforced by the supervisor and says how long it was', async () => {
  await coding.close()
  await app.close()
  await boot({ maxTurnMs: 1500 })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] take your time')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(runs()[0]!.error).toMatch(/Stopped after/)
  expect(launches()[0]).toMatchObject({ stop_cause: 'deadline', phase: 'settled' })
})

test('socket loss stops the CLI tree, proves the unit ended, and the result is not used', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] take your time')
  await vi.waitFor(() => expect(runs()[0]?.status).toBe('running'), { timeout: 15_000 })
  await vi.waitFor(() => expect(cliCalls()).toHaveLength(1), { timeout: 15_000 })
  const sockets = (backend.socket as unknown as { sockets: Set<{ destroy(): void }> }).sockets
  for (const socket of sockets) socket.destroy()
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(runs()[0]!.error).toMatch(/complete record/)
  const [launch] = launches()
  expect(launch).toMatchObject({ phase: 'settled', held: 0 })
  expect(launch!.proof).toBeTruthy()
})

test('an ingest failure stops the run and makes the result ineligible (the swallowed-error path is gone)', async () => {
  await coding.close()
  await app.close()
  let count = 0
  await boot({
    ingestWrap: (real) => ({
      submit: (observation) => {
        // The second event of the run cannot be saved.
        if (
          observation.identity.startsWith('coding:') &&
          /:1$/.test(observation.identity) &&
          count++ === 0
        )
          return Promise.reject(new Error('database is locked'))
        return real.submit(observation)
      },
    }),
  })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(runs()[0]!.error).toMatch(/complete record/)
  expect(launches()[0]).toMatchObject({ phase: 'settled' })
})

test('Stop on a supervised run this process no longer holds stops the unit by name and ends the run', async () => {
  await addAgent()
  const seed = seedLaunch('releasing', { withUnit: true, receipts: ['released.json'] })
  const outcome = await coding.stopRun({ agentId: 'coder', runId: seed.runId })
  expect(outcome).toBe('stopped')
  expect(fake.units.size).toBe(0)
  expect(runRow(seed.runId).status).toBe('cancelled')
  expect(launchRow(seed.launchId)).toMatchObject({ phase: 'settled', held: 0 })
})

test('the user can stop a run whose unit ignores the stop: the answer is unconfirmed and the loop goes on', async () => {
  await coding.close()
  await app.close()
  await boot({ stopObserveMs: 300, reapRetryMs: 30, unit: { proofTimeoutMs: 200 } })
  await addAgent()
  fake.hooks.ignoreStop = true
  const seed = seedLaunch('releasing', { withUnit: true })
  const outcome = await coding.stopRun({ agentId: 'coder', runId: seed.runId })
  expect(outcome).toBe('unconfirmed')
  await vi.waitFor(() => expect(launchRow(seed.launchId).held).toBeGreaterThan(0), {
    timeout: 5000,
  })
  fake.hooks.ignoreStop = false
  await vi.waitFor(() => expect(launchRow(seed.launchId).phase).toBe('settled'), {
    timeout: 15_000,
  })
  expect(runRow(seed.runId).status).toBe('cancelled')
})

test('#14: the stop cause is saved before the stop frame is sent', async () => {
  const seen: (string | null)[] = []
  const original = RunSession.prototype.stop
  vi.spyOn(RunSession.prototype, 'stop').mockImplementation(function (
    this: RunSession,
    cause: string,
  ) {
    seen.push(launches()[0]?.stop_cause ?? null)
    return original.call(this, cause)
  })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] take your time')
  await vi.waitFor(() => expect(replies()[0]?.parts.length).toBeGreaterThan(0), { timeout: 15_000 })
  await coding.stopRun({ agentId: 'coder', runId: runs()[0]!.id })
  await finished()
  expect(seen).toEqual(['user'])
})

test('#14: a stop on a launch Score no longer holds saves its cause before the unit is stopped', async () => {
  await addAgent()
  const seed = seedLaunch('releasing', { withUnit: true, receipts: ['released.json'] })
  const live = seed.live!
  const handler = live.stopHandler
  const seen: (string | null)[] = []
  live.stopHandler = () => {
    seen.push(launchRow(seed.launchId).stop_cause)
    handler?.()
  }
  await coding.stopRun({ agentId: 'coder', runId: seed.runId })
  expect(seen).toEqual(['user'])
})

test('#14 (re-review): the stop cause is journaled before any signal reaches the supervisor', async () => {
  await addAgent()
  const seed = seedLaunch('releasing', { withUnit: true, receipts: ['released.json'] })
  const order: string[] = []
  const original = CodingJournal.prototype.recordStop
  vi.spyOn(CodingJournal.prototype, 'recordStop').mockImplementation(function (
    this: CodingJournal,
    ...args: Parameters<CodingJournal['recordStop']>
  ) {
    order.push(`journal:${args[1]}`)
    return original.apply(this, args)
  })
  const handler = seed.live!.stopHandler
  seed.live!.stopHandler = () => {
    order.push('signal')
    handler?.()
  }
  await coding.stopRun({ agentId: 'coder', runId: seed.runId })
  expect(order).toEqual(['journal:user', 'signal'])
})
