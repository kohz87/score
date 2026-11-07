import { type CodingAgent } from '@score/contract'
import { beforeEach, expect, test, vi } from 'vitest'
import { spawnCli } from '../../src/runtimes/coding/process.ts'
import {
  addAgent,
  app,
  calls,
  coding,
  db,
  finished,
  ingest,
  launchedTurns,
  launches,
  makeRoom,
  pidAlive,
  processRows,
  rebootWith,
  request,
  runRow,
  runs,
  say,
  seedCrashedRun,
  setupCodingRuntime,
  spawned,
  workspace,
} from './coding-runtime-helpers.ts'

let spawnExtra: Partial<Parameters<typeof spawnCli>[0]> = {}

setupCodingRuntime(() => spawnExtra)
beforeEach(() => {
  spawnExtra = {}
})

// ---- Fix batch W: the runtime claims a process ended only when it can prove it. ----

test('W2: recovery keeps the record of a group it could not prove gone, fences the agent, and retries until it is', async () => {
  let outcome: 'alive' | 'unobservable' | 'gone' = 'alive'
  const asked: number[] = []
  await rebootWith({
    reapRetryMs: 20,
    killGroup: async (record) => {
      asked.push(record.pid)
      return outcome
    },
  })
  await addAgent()
  await makeRoom()
  seedCrashedRun('cr_dead', { pid: 4_000_001, start: '5' })
  expect(await coding.recover()).toBe(1)
  // The run ends with a plain note, but the record stays and is marked unresolved.
  expect(runRow('cr_dead')).toMatchObject({ status: 'interrupted', terminal_source: 'unconfirmed' })
  expect(runRow('cr_dead').error).toMatch(/Some of its tools may still be running/)
  expect(processRows()).toEqual([{ run_id: 'cr_dead', unresolved: 1 }])
  // The agent takes no new turn while that record remains, with a clear message.
  const refused = await coding
    .startRun({ agentId: 'coder', input: 'go', turnId: 't-fenced' })
    .catch((error: unknown) => error)
  expect(refused).toMatchObject({ status: 422, code: 'agent_still_stopping' })
  expect(launches).toBe(0)
  // Background retries keep asking; unobservable is no better than alive.
  outcome = 'unobservable'
  await vi.waitFor(() => expect(asked.length).toBeGreaterThanOrEqual(3), { timeout: 5000 })
  expect(processRows()).toHaveLength(1)
  // Once the group is proven gone the record goes and the agent is free again.
  outcome = 'gone'
  await vi.waitFor(() => expect(processRows()).toEqual([]), { timeout: 5000 })
  const { runId } = await coding.startRun({ agentId: 'coder', input: 'go', turnId: 't-free' })
  await vi.waitFor(() => expect(runRow(runId).status).toBe('completed'), { timeout: 15_000 })
})

test('W2: recovery deletes the record only on proof (a gone group)', async () => {
  await rebootWith({ killGroup: async () => 'gone' })
  await addAgent()
  seedCrashedRun('cr_gone', { pid: 4_000_002, start: '5' })
  await coding.recover()
  expect(processRows()).toEqual([])
  expect(runRow('cr_gone').terminal_source).toBeNull()
})

test('W3: a turn whose tools survive every signal still ends, but unconfirmed, with the record kept and the agent fenced', async () => {
  // Group signals never arrive: the tool the CLI left behind stays up past the reaper's deadline.
  spawnExtra = {
    signalGroup: () => 'unavailable',
    signalPid: () => 'unavailable',
    reapSlackMs: 100,
  }
  let gone = false
  await rebootWith({
    graceMs: 50,
    reapRetryMs: 20,
    killGroup: async (record) => {
      if (!gone) return 'alive'
      try {
        process.kill(-record.pgid, 'SIGKILL')
      } catch {
        // already gone
      }
      return 'gone'
    },
  })
  try {
    await addAgent()
    await makeRoom()
    await say('@coder [fixture:leftover] go')
    await finished()
    const row = runs()[0]!
    // The CLI finished cleanly, but "completed" is not evidence while a tool it started may still be running
    // (review 2026-10-12 #2): no ended proof, no success and no reply.
    expect(row.status).toBe('failed')
    expect(runRow(row.id).terminal_source).toBe('unconfirmed')
    expect(
      db.sqlite.prepare("SELECT 1 FROM message_runs WHERE from_agent_id = 'coder'").all(),
    ).toEqual([])
    expect(runRow(row.id).error).toMatch(/Some of its tools may still be running/)
    expect(processRows()).toEqual([{ run_id: row.id, unresolved: 1 }])
    expect(pidAlive(-spawned[0]!)).toBe(true)
    // No new turn, with a clear message in Chat.
    const refused = await coding
      .startRun({ agentId: 'coder', input: 'go', turnId: 't-next' })
      .catch((error: unknown) => error)
    expect(refused).toMatchObject({ status: 422, code: 'agent_still_stopping' })
    // Re-reaping in the background ends it and releases the agent.
    gone = true
    await vi.waitFor(() => expect(processRows()).toEqual([]), { timeout: 5000 })
    expect(pidAlive(-spawned[0]!)).toBe(false)
    spawnExtra = {}
    await coding.startRun({ agentId: 'coder', input: 'go', turnId: 't-after' })
    await finished(2)
  } finally {
    try {
      process.kill(-spawned[0]!, 'SIGKILL')
    } catch {
      // gone
    }
  }
})

test('X4: Stop on a running turn is `stopped` only once the group is proven gone, `unconfirmed` while a survivor lives', async () => {
  // Group signals never arrive, so the turn's process keeps running after Stop.
  spawnExtra = {
    signalGroup: () => 'unavailable',
    signalPid: () => 'unavailable',
    reapSlackMs: 100,
  }
  // The turn gives up on an undeliverable SIGKILL and the service re-reaps; its answer is the test's own observation
  // of the survivor (never a real kill), so load cannot make the first answer a proof.
  await rebootWith({
    graceMs: 50,
    stopObserveMs: 700,
    reapRetryMs: 20,
    killGroup: async (record) => (pidAlive(-record.pgid) ? 'alive' : 'gone'),
  })
  try {
    await addAgent()
    await makeRoom()
    await say('@coder [fixture:slow] hold')
    await vi.waitFor(() => expect(spawned.length).toBe(1), { timeout: 15_000 })
    const runId = runs()[0]!.id
    // The survivor is still alive when Stop's observation window ends.
    expect(await coding.stopRun({ agentId: 'coder', runId })).toBe('unconfirmed')
    expect(pidAlive(-spawned[0]!)).toBe(true)
    // The next turn is held back until the group is really gone.
    // Now it dies (our own child): the same question is answered with proof.
    setTimeout(() => process.kill(-spawned[0]!, 'SIGKILL'), 150)
    expect(await coding.stopRun({ agentId: 'coder', runId })).toBe('stopped')
    expect(pidAlive(-spawned[0]!)).toBe(false)
  } finally {
    try {
      process.kill(-spawned[0]!, 'SIGKILL')
    } catch {
      // gone
    }
  }
}, 60_000)

test('X4: Stop on a turn that has not started anything is stopped at once and nothing launches', async () => {
  await addAgent()
  await makeRoom()
  await coding.startRun({ agentId: 'coder', input: '[fixture:slow] hold', turnId: 't-x4-first' })
  const second = await coding.startRun({ agentId: 'coder', input: 'go', turnId: 't-x4-second' })
  expect(await coding.stopRun({ agentId: 'coder', runId: second.runId })).toBe('stopped')
  await coding.stopRun({ agentId: 'coder', runId: runs()[0]!.id })
  await vi.waitFor(() => expect(runRow(second.runId).status).toBe('cancelled'), {
    timeout: 20_000,
  })
  expect(launchedTurns('go')).toEqual([])
})

test('X2: unobservable records are marked releasable; Release deletes them, never signals, and leaves an audit row', async () => {
  let outcome: 'alive' | 'unobservable' = 'unobservable'
  await rebootWith({ reapRetryMs: 20, killGroup: async () => outcome })
  await addAgent()
  await makeRoom()
  const signalled: unknown[] = []
  const realKill = process.kill
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    if (sig !== 0 && sig !== undefined) signalled.push([pid, sig])
    return realKill(pid, sig as NodeJS.Signals)
  }) as typeof process.kill)
  seedCrashedRun('cr_unclear', { pid: 4_000_011, start: '5' })
  await coding.recover()
  const held = async () =>
    ((await request('GET', '/api/coding-agents')).json() as { items: CodingAgent[] }).items[0]!
      .heldGroups
  expect(await held()).toEqual([{ runId: 'cr_unclear', pgid: 4_000_011, canRelease: true }])
  // Nothing to release while the cause is not "can't tell whose": a group that is merely still alive.
  outcome = 'alive'
  await vi.waitFor(async () => expect((await held())[0]!.canRelease).toBe(false), { timeout: 5000 })
  expect((await request('POST', '/api/coding-agents/coder/release', {})).statusCode).toBe(409)
  outcome = 'unobservable'
  await vi.waitFor(async () => expect((await held())[0]!.canRelease).toBe(true), { timeout: 5000 })
  // Release needs a paired browser.
  const anonymous = await app.inject({
    method: 'POST',
    url: '/api/coding-agents/coder/release',
    headers: { 'x-score-client': 'web' },
    payload: {},
  })
  expect(anonymous.statusCode).toBe(401)
  const released = await request('POST', '/api/coding-agents/coder/release', {})
  expect(released.statusCode, released.body).toBe(200)
  expect((released.json() as CodingAgent).heldGroups).toEqual([])
  expect(processRows()).toEqual([])
  expect(signalled).toEqual([])
  const audit = db.sqlite.prepare('SELECT * FROM coding_releases').all() as {
    agent_id: string
    run_id: string
    pgid: number
    released_by: string
    released_at: string
  }[]
  expect(audit).toHaveLength(1)
  expect(audit[0]).toMatchObject({ agent_id: 'coder', run_id: 'cr_unclear', pgid: 4_000_011 })
  expect(audit[0]!.released_by).toMatch(/^[0-9a-f]{16}/)
  expect(Date.parse(audit[0]!.released_at)).not.toBeNaN()
  // A release is not termination evidence: the run stays unconfirmed. The agent takes turns again.
  expect(runRow('cr_unclear').terminal_source).toBe('unconfirmed')
  const { runId } = await coding.startRun({
    agentId: 'coder',
    input: 'go',
    turnId: 't-after-release',
  })
  await vi.waitFor(() => expect(runRow(runId).status).toBe('completed'), { timeout: 15_000 })
  // Nothing left to release.
  expect((await request('POST', '/api/coding-agents/coder/release', {})).statusCode).toBe(409)
  expect((await request('POST', '/api/coding-agents/nobody/release', {})).statusCode).toBe(404)
})

test('W3: the process record goes with the terminal result and never before it', async () => {
  await addAgent()
  await makeRoom()
  const realSubmit = ingest.submit.bind(ingest)
  const recordWhenSaved: boolean[] = []
  // Every attempt to save the result fails, like a crash between reaping and the write.
  vi.spyOn(ingest, 'submit').mockImplementation(async (observation) => {
    if (observation.identity.includes(':terminal')) {
      recordWhenSaved.push(processRows().length === 1)
      throw new Error('database is busy')
    }
    return realSubmit(observation)
  })
  await say('@coder go')
  await vi.waitFor(() => expect(recordWhenSaved.length).toBeGreaterThanOrEqual(2), {
    timeout: 15_000,
  })
  // The group was reaped, yet the record is still there: the result was not saved, so the work is not "released".
  expect(processRows()).toHaveLength(1)
  expect(recordWhenSaved.every(Boolean)).toBe(true)
  vi.restoreAllMocks()
})

test('W3: a saved result releases the record in the same step', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder go')
  await finished()
  expect(runs()[0]).toMatchObject({ status: 'completed' })
  expect(processRows()).toEqual([])
  expect(runRow(runs()[0]!.id).terminal_source).toBeNull()
})

test('W3: when recording the process fails the error waits for the proven end of the group', async () => {
  const { SpawnRecordError } = await import('../../src/runtimes/coding/process.ts')
  const { scanGroup, processStart: startOf } = await import('../../src/runtimes/coding/proc.ts')
  let pid = 0
  const boom = new Error('cannot record')
  let thrown: unknown
  try {
    spawnCli({
      file: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: workspace,
      env: { PATH: process.env.PATH ?? '' },
      stdin: '',
      parser: { parse: () => [], stats: { unknown: 0, malformed: 0 } },
      onEvent: async () => undefined,
      onSpawn: (spawnedPid) => {
        pid = spawnedPid
        throw boom
      },
    })
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(SpawnRecordError)
  expect((thrown as InstanceType<typeof SpawnRecordError>).original).toBe(boom)
  // The caller can wait for the proof; once it settles the whole group is gone.
  expect(await (thrown as InstanceType<typeof SpawnRecordError>).terminated).toBe(true)
  expect(pidAlive(pid) && startOf(pid) !== null && scanGroup(pid).members.length > 0).toBe(false)
})

test('W4: Stop on a run this process no longer holds says what really happened', async () => {
  await addAgent()
  await makeRoom()
  let outcome: 'alive' | 'gone' = 'alive'
  await rebootWith({ stopObserveMs: 100, reapRetryMs: 20, killGroup: async () => outcome })
  const stop = (runId: string) => coding.stopRun({ agentId: 'coder', runId })
  // A queued run never launched: cancelled, with proof.
  const now = new Date().toISOString()
  db.sqlite
    .prepare(
      `INSERT INTO runs (id, profile, origin, score_turn_id, status, started_at, updated_at, runtime)
       VALUES ('cr_queued', 'coder', 'score', 'turn-q', 'queued', ?, ?, 'claude-code')`,
    )
    .run(now, now)
  expect(await stop('cr_queued')).toBe('stopped')
  expect(runRow('cr_queued').status).toBe('cancelled')
  // Already ended, nothing recorded: nothing to stop.
  expect(await stop('cr_queued')).toBe('not_running')
  expect(await stop('cr_unknown')).toBe('not_running')
  // Running but this process has no record of it and no process row: can't be sure.
  seedCrashedRun('cr_orphan')
  expect(await stop('cr_orphan')).toBe('unconfirmed')
  // A process row that can't be proven gone: unconfirmed, and the kill keeps going.
  seedCrashedRun('cr_alive', { pid: 4_000_003, start: '5' })
  expect(await stop('cr_alive')).toBe('unconfirmed')
  expect(processRows().map((row) => row.run_id)).toContain('cr_alive')
  // Proven gone: stopped, and the record is released.
  outcome = 'gone'
  await vi.waitFor(() => expect(processRows().map((row) => row.run_id)).not.toContain('cr_alive'), {
    timeout: 5000,
  })
  seedCrashedRun('cr_dead', { pid: 4_000_004, start: '5' })
  expect(await stop('cr_dead')).toBe('stopped')
  expect(processRows().map((row) => row.run_id)).not.toContain('cr_dead')
  // A run held in memory is simply told to stop.
  const live = await coding.startRun({
    agentId: 'coder',
    input: '[fixture:slow] hold',
    turnId: 't-live',
  })
  expect(await stop(live.runId)).toBe('stopped')
  await vi.waitFor(() => expect(runRow(live.runId).status).toBe('cancelled'), { timeout: 15_000 })
})

test('W5: the resume fallback runs only for the CLI’s own refusal, with nothing observed, and shares the deadline', async () => {
  await addAgent()
  await makeRoom()
  // A generic "not found" is a failure, not permission to run the turn again.
  await say('@coder [fixture:basic] one')
  await finished(1)
  await say('@coder [fixture:notfound] two')
  await finished(2)
  expect(runs()[1]).toMatchObject({ status: 'failed' })
  expect(runs()[1]!.error).toMatch(/File not found/)
  expect(calls().filter((call) => call.prompt.includes('two'))).toHaveLength(1)
  // The CLI refused the session but had already produced output: it ran, so it is not run again.
  await say('@coder [fixture:observed] three')
  await finished(3)
  expect(runs()[2]).toMatchObject({ status: 'failed' })
  expect(calls().filter((call) => call.prompt.includes('three'))).toHaveLength(1)
})

test('W5: a refused resume that nothing ran behind starts fresh once, within the first turn’s deadline', async () => {
  await rebootWith({ maxTurnMs: 6000, graceMs: 100 })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] one')
  await finished(1)
  // The resumed launch refuses after 3 s; the fresh one needs 4 s but only ~3 s of the 6 are left.
  await say('@coder [fixture:slowstale] two')
  await finished(2)
  expect(
    calls()
      .filter((call) => call.prompt.includes('two'))
      .map((call) => call.args.includes('--resume')),
  ).toEqual([true, false])
  expect(runs()[1]).toMatchObject({ status: 'failed' })
  expect(processRows()).toEqual([])
})

test('FV #3: on the fallback too, a refusal behind an unreadable record is not retried', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:stalelossy] one')
  await finished(1)
  const before = launches
  await say('@coder [fixture:stalelossy] two')
  await finished(2)
  expect(launches - before).toBe(1)
  expect(runs()[1]).toMatchObject({ status: 'failed' })
})
