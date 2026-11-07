import { afterEach, beforeEach, expect, test } from 'vitest'
import { existsSync, fstatSync, fsyncSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { GlobalFenceStore } from '../../src/domain/orchestration/fence.ts'
import {
  UNIT_CAPABLE_FILE,
  fallbackForced,
  fenceBarrier,
} from '../../src/runtimes/coding/unit-backend.ts'
import { writeReceipt } from '../../src/runtimes/coding/supervisor.mjs'
import type { Ingest } from '../../src/hub/ingest.ts'
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
  launches,
  makeRoom,
  namespace,
  processLaunches,
  request,
  runs,
  say,
  seedLaunch,
} from './coding-units-runtime-helpers.ts'

beforeEach(beforeEachHarness)
afterEach(afterEachHarness)

// ---- the process-group fallback's reconciliation (re-review #6) -------------------------------------------------------

test('#6 (re-review): an unresolved fallback group whose run row is gone fences every agent and is visible', async () => {
  await coding.close()
  await app.close()
  await boot({ noUnit: true })
  await addAgent()
  const seed = { runId: 'cr_lostrun' }
  db.sqlite
    .prepare(
      `INSERT INTO coding_processes (run_id, pid, pgid, start_time, boot_id, created_at, unresolved, unobservable)
       VALUES (?, 0, 0, NULL, NULL, ?, 1, 1)`,
    )
    .run(seed.runId, new Date().toISOString())
  const refused = await coding
    .startRun({ agentId: 'coder', input: 'go', turnId: 't-lost-routing' })
    .catch((error: unknown) => error)
  expect(refused).toMatchObject({ status: 422, code: 'agent_still_stopping' })
  expect((await request('GET', '/api/coding-agents')).json().items[0].heldGroups).toHaveLength(1)
})

// ---- third review round (FZ2; decision 69) ---------------------------------------------------------------------------

const marker = () => join(namespace, UNIT_CAPABLE_FILE)

test('decision 69: the first passing check is remembered; a later failure pauses coding instead of falling back', async () => {
  expect(existsSync(marker())).toBe(true)
  await addAgent()
  await makeRoom()
  fake.hooks.lingerOff = true
  const recheck = await request('POST', '/api/coding-agents/backend/check', {})
  expect(recheck.json()).toMatchObject({ kind: 'unit' })
  expect(recheck.json().note).toMatch(/^Coding runs are paused/)
  expect(recheck.json().checks.find((c: { name: string }) => c.name === 'linger')).toMatchObject({
    ok: false,
  })
  expect(backend.usable()).toBe(false)
  const refused = await coding
    .startRun({ agentId: 'coder', input: 'go', turnId: 't-paused' })
    .catch((error: unknown) => error)
  expect(refused).toMatchObject({ status: 422, code: 'coding_paused' })
  expect(processLaunches).toBe(0)
  // A restart of Score on the same installation stays paused: the marker lives beside the journal.
  await coding.close()
  await app.close()
  await boot()
  expect(backend.status.kind).toBe('unit')
  expect(backend.block()).toMatch(/paused/)
  expect(backend.usable()).toBe(false)
  // The person fixes the host and presses Check again: runs resume as supervised services.
  fake.hooks.lingerOff = false
  await request('POST', '/api/coding-agents/backend/check', {})
  expect(backend.block()).toBeNull()
  await say('@coder [fixture:basic] go')
  await finished()
  expect(runs()[0]!.status).toBe('completed')
  expect(processLaunches).toBe(0)
  expect(launches().map((l) => l.backend)).toEqual(['unit'])
})

test('decision 69: a forced fallback is a choice, not a failure: it never pauses', async () => {
  await coding.close()
  await app.close()
  await boot({ unit: { disabled: 'The fallback is forced.', forced: true } })
  expect(backend.status.kind).toBe('process-group')
  expect(backend.block()).toBeNull()
})

test('FW #2: a marker that can’t be written pauses coding until it is durable; a restart never falls back', async () => {
  await coding.close()
  await app.close()
  rmSync(marker(), { force: true })
  let full = true
  const diskFull = {
    writeSync: (fd: number, data: Buffer, offset: number, length: number) => {
      if (full) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
      return writeSync(fd, data, offset, length)
    },
  }
  try {
    await boot({ unit: { markerIo: diskFull } })
    await addAgent()
    await makeRoom()
    expect(backend.status.kind).toBe('unit')
    expect(backend.usable()).toBe(false)
    expect(backend.block()).toMatch(/paused/)
    expect(existsSync(marker())).toBe(false)
    const refused = await coding
      .startRun({ agentId: 'coder', input: 'go', turnId: 't-nomarker' })
      .catch((error: unknown) => error)
    expect(refused).toMatchObject({ status: 422, code: 'coding_paused' })
  } finally {
    full = false
  }
  // The disk recovers: the retry writes it and coding resumes without another check.
  expect(backend.usable()).toBe(true)
  expect(existsSync(marker())).toBe(true)
  errors.length = 0
})

test('FV #2: a marker whose directory sync failed after the name appeared stays paused until the sync succeeds (an existing marker is not a durable one)', async () => {
  await coding.close()
  await app.close()
  rmSync(marker(), { force: true })
  let broken = true
  const syncs: string[] = []
  const flakyDirectory = {
    fsyncSync: (fd: number) => {
      const isDirectory = fstatSync(fd).isDirectory()
      syncs.push(isDirectory ? 'dir' : 'file')
      if (isDirectory && broken)
        throw Object.assign(new Error('input/output error'), { code: 'EIO' })
      fsyncSync(fd)
    },
  }
  try {
    await boot({ unit: { markerIo: flakyDirectory } })
    // The name is there (the link worked), but its directory never synced.
    expect(existsSync(marker())).toBe(true)
    expect(backend.usable()).toBe(false)
    expect(backend.block()).toMatch(/paused/)
    // The next attempt finds the name (EEXIST); it must sync again, and while that fails the pause stays.
    syncs.length = 0
    expect(backend.block()).toMatch(/paused/)
    expect(syncs).toContain('dir')
    expect(backend.usable()).toBe(false)
    broken = false
    expect(backend.block()).toBeNull()
    expect(backend.usable()).toBe(true)
  } finally {
    broken = false
  }
  errors.length = 0
})

test('FV #2: a marker that isn’t this installation’s is never trusted', async () => {
  await coding.close()
  await app.close()
  writeFileSync(marker(), JSON.stringify({ installation: 'someone-else', at: 1 }))
  await boot()
  expect(backend.usable()).toBe(false)
  expect(backend.block()).toMatch(/paused/)
  errors.length = 0
})

test('FW #2: the environment forces the fallback only under the test harness, never in production', () => {
  expect(fallbackForced({ SCORE_CODING_BACKEND: 'process-group', NODE_ENV: 'production' })).toBe(
    false,
  )
  expect(fallbackForced({ SCORE_CODING_BACKEND: 'process-group' })).toBe(false)
  expect(fallbackForced({ SCORE_CODING_BACKEND: 'process-group', NODE_ENV: 'test' })).toBe(true)
  expect(fallbackForced({ NODE_ENV: 'test' })).toBe(false)
})

test('FW #2: a lost marker is recovered from owned unit history: a failing host pauses instead of falling back', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] go')
  await finished()
  expect(launches().map((l) => l.backend)).toEqual(['unit'])
  await coding.close()
  await app.close()
  rmSync(marker(), { force: true })
  fake.hooks.lingerOff = true
  await boot()
  expect(backend.status.kind).toBe('unit')
  expect(backend.block()).toMatch(/paused/)
  expect(backend.usable()).toBe(false)
})

test('re-review 2 #2: restore, journal, journal-root and installation fences stop coding through the production classifier', () => {
  const fence = new GlobalFenceStore(db, journal)
  const clear = () => {
    db.sqlite.prepare('UPDATE orc_global SET fenced = 0 WHERE id = 1').run()
    db.sqlite.prepare('DELETE FROM orc_fence_items').run()
  }
  const items = [
    { kind: 'restore' as const, ref: 'restore:backup', journalN: null, detail: 'x' },
    { kind: 'journal' as const, ref: 'journal', journalN: null, detail: 'x' },
    { kind: 'journal' as const, ref: 'journal-root', journalN: null, detail: 'x' },
    { kind: 'journal' as const, ref: 'installation', journalN: null, detail: 'x' },
    { kind: 'fence' as const, ref: 'coding:L1', journalN: null, detail: 'x' },
  ]
  expect(fenceBarrier(db.sqlite)).toBeNull()
  for (const item of items) {
    fence.set('test', [item])
    expect(fenceBarrier(db.sqlite), item.ref).toMatch(/review the execution journal/)
    clear()
  }
  // Doubts about orchestration attempts alone don't concern coding.
  fence.set('test', [{ kind: 'attempt', ref: 'attempt:1', journalN: null, detail: 'x' }])
  expect(fenceBarrier(db.sqlite)).toBeNull()
  clear()
})

for (const engine of ['unit', 'process-group'] as const) {
  test(`re-review 2 #2: a restore fence raised after admission stops the ${engine} release: no releasing record, no CLI`, async () => {
    const raise = () => {
      new GlobalFenceStore(db, journal).set('test', [
        { kind: 'restore', ref: 'restore:backup', journalN: null, detail: 'a restored backup' },
      ])
    }
    await coding.close()
    await app.close()
    await boot({
      // The production callback, not an injected blocker.
      blocked: () => fenceBarrier(db.sqlite),
      ...(engine === 'process-group'
        ? {
            unit: { disabled: 'The fallback is forced.', forced: true },
            ingestWrap: (real: Ingest) => ({
              submit: (observation: Parameters<Ingest['submit']>[0]) => {
                if (observation.identity.endsWith(':running')) raise()
                return real.submit(observation)
              },
            }),
          }
        : {}),
    })
    // The unit backend raises it once the unit started, before the release.
    if (engine === 'unit') fake.hooks.afterStart = () => raise()
    await addAgent()
    await makeRoom()
    await say('@coder [fixture:basic] go')
    await finished()
    expect(processLaunches).toBe(0)
    expect(cliCalls()).toHaveLength(0)
    const kinds = (journal.readOwn() as { entries: { kind: string }[] }).entries.map((e) => e.kind)
    expect(kinds).not.toContain('releasing')
    expect(runs()[0]!.status).toBe('failed')
  })
}

const routingFile = (launchId: string, runId: string) =>
  writeReceipt(join(namespace, 'launches', launchId), 'routing.json', {
    launch: launchId,
    generation: 0,
    at: Date.now(),
    agentId: 'coder',
    runtime: 'claude-code',
    runId,
    turnId: `turn-${runId}`,
  })

test('re-review 2 #7: a restored unit launch that lost its rows is routed from the file beside the journal', async () => {
  await coding.close()
  await app.close()
  fake.hooks.ignoreStop = true
  await boot({ unit: { recoverProofMs: 200 }, reapRetryMs: 60_000 })
  await addAgent()
  const seed = seedLaunch('releasing', { withUnit: true, receipts: ['released.json'] })
  routingFile(seed.launchId, seed.runId)
  // A restored backup: neither the launch row nor the run row exists any more.
  db.sqlite.prepare('DELETE FROM coding_launches WHERE launch_id = ?').run(seed.launchId)
  db.sqlite.prepare('DELETE FROM runs WHERE id = ?').run(seed.runId)
  await backend.recover()
  expect(backend.held('coder').map((h) => h.launchId)).toEqual([seed.launchId])
  expect(backend.block()).toBeNull()
})

test('re-review 2 #7: an owned unfinished launch nobody can be named for fences all coding admission', async () => {
  await coding.close()
  await app.close()
  fake.hooks.ignoreStop = true
  await boot({ unit: { recoverProofMs: 200 }, reapRetryMs: 60_000 })
  await addAgent()
  const seed = seedLaunch('releasing', { withUnit: true, receipts: ['released.json'] })
  db.sqlite.prepare('DELETE FROM coding_launches WHERE launch_id = ?').run(seed.launchId)
  db.sqlite.prepare('DELETE FROM runs WHERE id = ?').run(seed.runId)
  await backend.recover()
  expect(backend.held('coder')).toEqual([])
  expect(backend.block()).toMatch(/which agent/)
  const refused = await coding
    .startRun({ agentId: 'coder', input: 'go', turnId: 't-unattributed' })
    .catch((error: unknown) => error)
  expect(refused).toMatchObject({ status: 422, code: 'coding_paused' })
})
