import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { CodingJournal } from '../../src/domain/orchestration/coding-journal.ts'
import { verifyCoding } from '../../src/domain/orchestration/coding-checkpoint.ts'
import { processStart } from '../../src/runtimes/coding/proc.ts'
import { writeReceipt } from '../../src/runtimes/coding/supervisor.mjs'
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
  errors,
  fake,
  finished,
  journal,
  journalKinds,
  launchRow,
  launches,
  makeRoom,
  namespace,
  runs,
  say,
  seedLaunch,
} from './coding-units-runtime-helpers.ts'

beforeEach(beforeEachHarness)
afterEach(afterEachHarness)

test('re-review 2 #8: the recorded supervisor is signalled only with a known matching boot, the same manager and the same unit', async () => {
  await addAgent()
  const unknown = async (label: string, seed: ReturnType<typeof seedLaunch>) => {
    expect(await backend.stopSupervisor(seed.launchId), label).toBe('unknown')
    expect(fake.signals, label).toEqual([])
  }
  // Recorded boot and manager unknown: PID and start time can recur across boots, so nothing is signalled.
  await unknown('no recorded boot', seedLaunch('releasing', { withUnit: true, manager: null }))
  // A different manager incarnation than the one that verified the launch.
  await unknown(
    'other manager',
    seedLaunch('releasing', { withUnit: true, manager: `${fake.boot}|1111:5` }),
  )
  // The unit systemd names now is another invocation, or its main process is not the recorded supervisor.
  const reused = seedLaunch('releasing', { withUnit: true })
  reused.live!.invocationId = 'a'.repeat(32)
  await unknown('other invocation', reused)
  const swapped = seedLaunch('releasing', { withUnit: true })
  fake.hooks.mainPid = 5
  await unknown('other main process', swapped)
  fake.hooks.mainPid = undefined
  // The current boot can't be read now.
  await coding.close()
  await app.close()
  await boot({
    unit: {
      proc: {
        start: (pid) => fake.procStart(pid) ?? processStart(pid),
        cgroup: (_pid, claimed) => claimed,
        boot: () => null,
      },
    },
  })
  await unknown('unreadable boot', seedLaunch('releasing', { withUnit: true }))
  // Everything known and matching: the one signal goes out.
  await coding.close()
  await app.close()
  await boot()
  const good = seedLaunch('releasing', { withUnit: true })
  expect(await backend.stopSupervisor(good.launchId)).toBe('signalled')
  expect(fake.signals).toEqual([expect.objectContaining({ pid: good.live!.pid, delivered: true })])
})

test('re-review 2 #10: eligibility needs the unit’s own exit status 0 from the recorded supervisor', async () => {
  fake.hooks.keepExited = true
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] go')
  await finished()
  expect(runs()[0]!.status).toBe('completed')
  // A supervisor that left with another status (ack lost, socket lost) is not a normal end, whatever the stream said.
  fake.hooks.execMainStatus = 2
  await say('@coder [fixture:basic] again')
  await finished(2)
  expect(runs()[1]!.status).toBe('failed')
  // ... and neither is a main process that isn't the supervisor Score recorded.
  fake.hooks.execMainStatus = undefined
  fake.hooks.execMainPid = 31337
  await say('@coder [fixture:basic] third')
  await finished(3)
  expect(runs()[2]!.status).toBe('failed')
})

test('FW #4: an absent unit is not a clean exit: without the supervisor’s final receipt the result is not eligible', async () => {
  await addAgent()
  await makeRoom()
  // The supervisor died with Score's acknowledgment unread, and the manager's replacement removed its failure metadata:
  // the unit is simply gone and no final receipt exists.
  fake.hooks.onExit = ({ receiptDir }) => rmSync(join(receiptDir, 'acked.json'), { force: true })
  await say('@coder [fixture:basic] go')
  await finished()
  expect(fake.units.size).toBe(0)
  expect(runs()[0]!.status).toBe('failed')
  expect(launches()[0]!.eligibility).toContain('supervisor-exit')
  // With the receipt in place the same shape of run (unit collected at once) completes.
  fake.hooks.onExit = undefined
  await say('@coder [fixture:basic] again')
  await finished(2)
  expect(runs()[1]!.status).toBe('completed')
})

test('FU #1: a replaced manager’s absent unit is not a clean exit, even with a receipt carrying `durable: true`', async () => {
  await addAgent()
  await makeRoom()
  // The probe of re-review 5: the supervisor's final publication failed (exit 1) but its receipt name survived with
  // `durable: true`, and the manager's replacement forgot the failed unit. Nothing but the receipt is left.
  fake.hooks.onExit = () => {
    fake.managerPid = 5151
  }
  await say('@coder [fixture:basic] go')
  await finished()
  expect(fake.units.size).toBe(0)
  expect(runs()[0]!.status).toBe('failed')
  expect(launches()[0]!.eligibility).toContain('supervisor-exit:absent')
  // The same shape with the manager unchanged: the unit left by garbage collection, which is a clean exit.
  fake.hooks.onExit = undefined
  await say('@coder [fixture:basic] again')
  await finished(2)
  expect(runs()[1]!.status).toBe('completed')
})

test('FW #8: the installation budget charges the translator’s call details and the result awaiting delivery, and releases them when cleared', async () => {
  await addAgent()
  await makeRoom()
  let peak = 0
  const timer = setInterval(() => {
    peak = Math.max(peak, backend.budgetBytes)
  }, 2)
  try {
    await say('@coder [fixture:manytools] go')
    await finished()
  } finally {
    clearInterval(timer)
  }
  expect(runs()[0]!.status).toBe('completed')
  // 128 remembered tool starts of 15 kB each are retained by the translator: far past the fixed 512 KiB reservation.
  expect(peak).toBeGreaterThan(1_500_000)
  // Delivered and settled: nothing stays charged.
  await vi.waitFor(() => expect(backend.budgetBytes).toBe(0), { timeout: 10_000 })
})

test('FW #9: a cause the supervisor recorded survives live completion: journal, database and verification agree', async () => {
  await addAgent()
  await makeRoom()
  fake.hooks.onExit = ({ receiptDir }) => {
    const launch = receiptDir.split('/').at(-1)!
    writeReceipt(receiptDir, 'stop-cause.json', {
      launch,
      generation: 0,
      at: Date.now(),
      cause: 'socket-loss',
    })
  }
  await say('@coder [fixture:basic] go')
  await finished()
  const [row] = launches()
  const read = journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  const stops = read.entries.filter(
    (e) => 'launchId' in e && e.launchId === row!.launch_id && e.kind === 'stop-requested',
  ) as unknown as { stopCause: string }[]
  expect(stops.map((e) => e.stopCause)).toEqual(['socket-loss'])
  expect(launchRow(row!.launch_id).stop_cause).toBe('socket-loss')
  expect(verifyCoding(db.sqlite, read.entries)).toEqual([])
})

test('FV #3: a stop cause the supervisor recorded first disqualifies completion even when the run otherwise looks clean', async () => {
  await addAgent()
  await makeRoom()
  // The supervisor stopped the run for its own reason, but the CLI finished with an explicit success before that.
  fake.hooks.onExit = ({ receiptDir }) => {
    const launch = receiptDir.split('/').at(-1)!
    writeReceipt(receiptDir, 'stop-cause.json', {
      launch,
      generation: 0,
      at: Date.now(),
      cause: 'deadline',
    })
  }
  await say('@coder [fixture:basic] go')
  await finished()
  const [row] = launches()
  const read = journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  const recorded = read.entries.filter(
    (e) => 'launchId' in e && e.launchId === row!.launch_id && e.kind === 'stop-requested',
  ) as unknown as { stopCause: string }[]
  expect(recorded.map((e) => e.stopCause)).toEqual(['deadline'])
  // The adopted cause stops the run from completing; the cause stays visible beside the (otherwise clean) evidence.
  expect(runs()[0]!.status).toBe('failed')
  expect(launchRow(row!.launch_id).eligibility).toContain('stop-cause:deadline')
  expect(launchRow(row!.launch_id).stop_cause).toBe('deadline')
})

test('FV #3: a run’s budget reservation is never released by a timer while it may still retain state; it goes when the state does', async () => {
  const delays: number[] = []
  const original = globalThis.setTimeout
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    handler: () => void,
    delay?: number,
  ) => {
    delays.push(delay ?? 0)
    return original(handler, delay)
  }) as unknown as typeof setTimeout)
  try {
    await addAgent()
    await makeRoom()
    await say('@coder [fixture:basic] go')
    await finished()
  } finally {
    spy.mockRestore()
  }
  // The old code armed a ten-minute release after every outcome, whatever the run still held.
  expect(delays.filter((delay) => delay >= 5 * 60_000)).toEqual([])
  // Delivery cleared the state: nothing stays charged.
  await vi.waitFor(() => expect(backend.budgetBytes).toBe(0))
})

test('FW #9: after real socket loss the supervisor’s first cause stays in the database too (live projection)', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] go')
  await vi.waitFor(() => expect(cliCalls().length).toBeGreaterThan(0), { timeout: 10_000 })
  // Score’s side of the connection dies: the supervisor stops the CLI by itself and records why.
  const sockets = (backend.socket as unknown as { sockets: Set<{ destroy(): void }> }).sockets
  for (const socket of [...sockets]) socket.destroy()
  await finished()
  const [row] = launches()
  const read = journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  const stops = read.entries.filter(
    (e) => 'launchId' in e && e.launchId === row!.launch_id && e.kind === 'stop-requested',
  ) as unknown as { stopCause: string }[]
  expect(stops.map((e) => e.stopCause)).toEqual(['socket-loss'])
  expect(launchRow(row!.launch_id).stop_cause).toBe('socket-loss')
  expect(verifyCoding(db.sqlite, read.entries)).toEqual([])
})

test('FW #9: a stop receipt that is unreadable, foreign or for another generation is reported and costs the result', async () => {
  await addAgent()
  await makeRoom()
  errors.length = 0
  fake.hooks.onExit = ({ receiptDir }) => {
    const launch = receiptDir.split('/').at(-1)!
    writeReceipt(receiptDir, 'stop-cause.json', {
      launch,
      generation: 7,
      at: Date.now(),
      cause: 'deadline',
    })
  }
  await say('@coder [fixture:basic] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(launches()[0]!.eligibility).toContain('stop-unrecorded')
  expect(errors.map(String).join('\n')).toMatch(/stop-cause receipt/)
  errors.length = 0
})

test('re-review 2 #17: a first cause the supervisor wrote itself is adopted into the journal before the launch ends', async () => {
  await addAgent()
  const seed = seedLaunch('releasing', { receipts: ['released.json', 'ended.json'] })
  writeReceipt(join(namespace, 'launches', seed.launchId), 'stop-cause.json', {
    launch: seed.launchId,
    generation: 0,
    at: Date.now(),
    cause: 'socket-loss',
  })
  await backend.recover()
  const read = journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  const stops = read.entries.filter(
    (e) => 'launchId' in e && e.launchId === seed.launchId && e.kind === 'stop-requested',
  ) as unknown as { stopCause: string }[]
  expect(stops.map((e) => e.stopCause)).toEqual(['socket-loss'])
  expect(launchRow(seed.launchId).stop_cause).toBe('socket-loss')
})

async function failSecondEvent() {
  await coding.close()
  await app.close()
  let count = 0
  await boot({
    ingestWrap: (real) => ({
      submit: (observation) => {
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
}

test('re-review 2 #17: Score’s own stop on an ingestion failure is made durable in the journal first', async () => {
  await failSecondEvent()
  expect(runs()[0]!.status).toBe('failed')
  const launch = launches()[0]!
  expect(journalKinds(launch.launch_id)).toContain('stop-requested')
  const read = journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  expect(
    read.entries.filter((e) => 'launchId' in e && e.launchId === launch.launch_id).map((e) => e),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'stop-requested', stopCause: 'ingest-failure' }),
    ]),
  )
  expect(launch.stop_cause).toBe('ingest-failure')
})

test('re-review 2 #17: a stop cause that can’t be journaled stays visible: reported, and the stop still goes ahead', async () => {
  vi.spyOn(CodingJournal.prototype, 'recordStop').mockReturnValue({
    ok: false,
    reason: 'projection_failed',
  } as ReturnType<CodingJournal['recordStop']>)
  await failSecondEvent()
  expect(runs()[0]!.status).toBe('failed')
  expect(errors.map(String).join('\n')).toContain('stop cause not journaled')
  // The database still names the cause, so the person isn't left guessing.
  expect(launches()[0]!.stop_cause).toBe('ingest-failure')
})

test('FV #1: a frozen home admits no coding run and recovery signals no supervisor, then carries on once unfrozen', async () => {
  let holding: string | null =
    'Score is holding all agent work: this folder is a copy. Run scripts/score installation reset-history to continue.'
  await boot({ frozen: () => holding })
  await addAgent()
  const seed = seedLaunch('armed', { withUnit: true })
  const before = launchRow(seed.launchId)
  await coding.recover()
  // Nothing was signalled, stopped, revoked or settled: the launch is exactly as it was found.
  expect(fake.signals).toEqual([])
  expect(fake.units.has(seed.unit)).toBe(true)
  expect(launchRow(seed.launchId)).toMatchObject({ phase: before.phase, revoked: 0 })
  // Admission is refused with the sentence, the card says the same, and the unit backend blocks by itself.
  await expect(
    coding.startRun({ agentId: 'coder', input: 'hi', turnId: 'turn-frozen' }),
  ).rejects.toMatchObject({ message: holding })
  expect(coding.backend().note).toBe(holding)
  expect(coding.backend().checks.some((check) => !check.ok)).toBe(true)
  expect(backend.block()).toBe(holding)
  expect(await backend.stopSupervisor(seed.launchId)).toBe('unknown')
  expect(fake.signals).toEqual([])
  // The same state, unfrozen, does signal the recorded supervisor (the test can fail).
  holding = null
  await coding.recover()
  expect(fake.signals.filter((s) => s.delivered)).toHaveLength(1)
})

test('decision 74: while frozen, a run this Score started is still stopped over its own connection; nothing else is', async () => {
  let holding: string | null = null
  await coding.close()
  await app.close()
  await boot({ frozen: () => holding })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] take your time')
  await vi.waitFor(() => expect(runs()[0]?.status).toBe('running'), { timeout: 15_000 })
  holding = 'Score is holding all agent work: this folder is a copy.'
  // A run this process doesn't hold (recovered or inherited) is not stopped while frozen.
  await expect(
    coding.stopRun({ agentId: 'coder', runId: 'not-started-here' }),
  ).rejects.toMatchObject({
    status: 423,
    code: 'execution_frozen',
  })
  // Without a connected session the only way would be a signal to a recorded supervisor: none while frozen.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- private method observed, not called
  const signal = vi.spyOn(backend as any, 'stopSupervisor')
  backend.sendStop(launches()[0]!.launch_id, null, 'user')
  expect(signal).not.toHaveBeenCalled()
  // Its own connected run: the person's Stop goes out and the run ends.
  expect(await coding.stopRun({ agentId: 'coder', runId: runs()[0]!.id })).toBe('stopped')
  await finished()
  expect(runs()[0]!.status).not.toBe('running')
})
