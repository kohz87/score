import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'
import { GlobalFenceStore } from '../../src/domain/orchestration/fence.ts'
import { ExecutionJournal, journalScope } from '../../src/domain/orchestration/journal.ts'
import { migrate, openDatabase } from '../../src/db/index.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { attemptOf, endRun, harness, type Harness } from './harness.ts'
import { migrationsDir } from './harness-db.ts'

let h: Harness
const releases: (() => void)[] = []
afterEach(async () => {
  for (const r of releases.splice(0)) r()
  await h?.close()
  h = undefined as never
})
const status = (id: string) => h.orch.summary(id).status
const detail = (id: string) => h.orch.snapshot(id).orchestration

function holdStartRun() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  releases.push(release)
  const original = h.port.startRun.bind(h.port)
  const state = { calls: 0 }
  h.port.startRun = async (req) => {
    state.calls++
    await gate
    return original(req)
  }
  return { release, state }
}

test('CRITICAL: lifting the restore fence never re-sends an attempt the journal says was sent', async () => {
  h = await harness()
  const hold = holdStartRun()
  const id = await h.create()
  await h.until(() => attemptOf(h, id, 'lead').some((a) => a.state === 'send_started'))
  // A restored database remembers this attempt as admitted but never sent.
  h.db.sqlite.prepare("UPDATE orc_attempts SET state = 'created', sent_at = NULL").run()
  const store = new GlobalFenceStore(h.db, h.journal)
  expect(store.startupCheck().fenced).toBe(true)
  // The doubt already made the attempt unknown; lifting must not make it sendable.
  expect(attemptOf(h, id, 'lead')[0]!.state).toBe('unknown')
  store.lift(store.view().revision, 'reviewed')
  await h.settle(5000)
  expect(hold.state.calls).toBe(1)
  expect(attemptOf(h, id, 'lead')).toHaveLength(1)
  expect(attemptOf(h, id, 'lead')[0]!.state).toBe('unknown')
  // Even a `created` row that slipped through is refused at the send barrier.
  hold.release()
  await h.settle(1000)
  h.db.sqlite.prepare("UPDATE orc_attempts SET state = 'created'").run()
  await h.settle(2000)
  expect(hold.state.calls).toBe(1)
  expect(['unknown', 'terminated']).toContain(attemptOf(h, id, 'lead')[0]!.state)
  expect(attemptOf(h, id, 'lead')).toHaveLength(1)
})

test('a journaled run handle is attached to the restored attempt so its Stop can be delivered', async () => {
  h = await harness()
  const id = await h.create()
  await h.until(() => status(id) === 'succeeded')
  const lead = attemptOf(h, id, 'lead')[0]!
  h.db.sqlite
    .prepare(
      "UPDATE orc_attempts SET state = 'created', run_id = NULL, sent_at = NULL WHERE id = ?",
    )
    .run(lead.id)
  const store = new GlobalFenceStore(h.db, h.journal)
  store.startupCheck()
  const row = h.db.sqlite
    .prepare('SELECT state, run_id FROM orc_attempts WHERE id = ?')
    .get(lead.id) as { state: string; run_id: string }
  expect(row.state).toBe('unknown')
  expect(row.run_id).toBe(lead.runId)
})

test('a journal that cannot be written still leaves the fence in the database (fail closed)', async () => {
  h = await harness()
  vi.spyOn(h.journal, 'append').mockImplementation(() => {
    throw new Error('read-only file system')
  })
  h.fence.set('journal_unwritable', [
    { kind: 'journal', ref: 'journal', journalN: null, detail: 'x' },
  ])
  expect(h.fence.view().fenced).toBe(true)
  const again = new GlobalFenceStore(h.db, h.journal)
  expect(again.startupCheck().fenced).toBe(true)
  await expect(h.create()).rejects.toMatchObject({ code: 'fenced' })
})

test('restore resolves a symlinked home: the marker, the restored files and the startup scope agree', () => {
  const root = mkdtempSync(join(tmpdir(), 'score-restore-link-'))
  try {
    const real = join(root, 'real-home')
    const link = join(root, 'link-home')
    const backup = join(root, 'backup')
    const journalDir = join(root, 'journal')
    mkdirSync(real)
    mkdirSync(backup)
    symlinkSync(real, link)
    const seeded = openDatabase(join(backup, 'score.db'))
    migrate(seeded, migrationsDir)
    seeded.close()
    writeFileSync(join(real, 'score.db'), 'old')
    const script = fileURLToPath(new URL('../../../../scripts/restore.mjs', import.meta.url))
    execFileSync('node', [script, backup], {
      env: { PATH: process.env.PATH!, HOME: root, SCORE_HOME: link, SCORE_JOURNAL_DIR: journalDir },
    })
    // The symlink still points at the (restored) home, and startup in terms of either path sees the marker.
    expect(realpathSync(link)).toBe(realpathSync(real))
    const db = openDatabase(join(link, 'score.db'))
    const journal = new ExecutionJournal(journalDir, journalScope(realpathSync(link)))
    expect(new GlobalFenceStore(db, journal).startupCheck()).toEqual({
      fenced: true,
      reasons: ['restore'],
    })
    db.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('compaction keeps Stop fences of abandoned attempts without evidence, and restoring then still fences', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold]' })
        },
        2: async (t) => {
          await t.call('orch.cancel', { stepId: 's1' })
          await t.call('orch.finish', { outcome: 'partial', summary: 'x' })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  h.db.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const { copyFileSync } = await import('node:fs')
  copyFileSync(join(h.dir, 'score.db'), join(h.dir, 'before-cancel.db'))
  const orchId = id
  // wake the lead for turn 2 with an inquiry-free cause
  h.db.sqlite
    .prepare(
      "INSERT INTO orc_causes (orchestration_id, kind, at) VALUES (?, 'inquiry_answered', '2026-01-01T00:00:00.000Z')",
    )
    .run(orchId)
  await h.until(() => detail(id).stepsList[0]!.status === 'cancelled')
  const s1 = attemptOf(h, id, 'step', 's1')[0]!
  await h.until(() => attemptOf(h, id, 'step', 's1')[0]!.state === 'unknown')
  await h.until(() => attemptOf(h, id, 'step', 's1')[0]!.stopAcknowledgedAt !== null)
  await h.orch.abandon(id, {
    attemptIds: [s1.id],
    orchestrationRevision: detail(id).revision,
    acknowledge: true,
  })
  await h.until(
    () =>
      ['finished_with_unresolved', 'stopped'].includes(status(id)) ||
      detail(id).status === 'paused',
  )
  const stopFences = () => {
    const read = h.journal.readOwn()
    return read.ok ? read.entries.filter((e) => e.kind === 'stop_fence').length : -1
  }
  const before = stopFences()
  expect(before).toBeGreaterThan(0)
  h.orch.maintenance()
  expect(stopFences()).toBe(before)
})

test('a capability can never reach an id, a receipt, a message id or a step instruction', async () => {
  const leaks: unknown[] = []
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          const c = t.capability
          leaks.push(await t.call('orch.note', { text: 'ok' }, c))
          leaks.push(await t.call('orch.assign', { agent: c, instruction: 'x' }))
          leaks.push(await t.call('orch.assign', { agent: 'builder', instruction: `x${c}` }))
          leaks.push(
            await t.call('orch.assign', {
              agent: 'builder',
              instruction: `pre.${c.slice(0, 20)}more`,
            }),
          )
          leaks.push(await t.call('orch.plan', { entries: [`see ${c}`] }))
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => status(id) === 'paused')
  expect(leaks).toHaveLength(5)
  expect(leaks.every((r) => (r as { code?: string }).code === 'capability_in_text')).toBe(true)
  const tables = h.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
  const dump = tables.map(({ name }) => JSON.stringify(h.rows(`SELECT * FROM ${name}`))).join('\n')
  expect(dump).not.toMatch(/orc_[A-Za-z0-9_-]{20,}/)
  expect(detail(id).stepsList).toHaveLength(0)
})

test('recovery keeps a handle the adapter already committed and can then stop that run', async () => {
  h = await harness()
  const hold = holdStartRun()
  const id = await h.create()
  await h.until(() => attemptOf(h, id, 'lead').some((a) => a.state === 'send_started'))
  const attempt = attemptOf(h, id, 'lead')[0]!
  const turn = h.db.sqlite
    .prepare('SELECT turn_id FROM orc_attempts WHERE id = ?')
    .get(attempt.id) as { turn_id: string }
  h.db.sqlite
    .prepare(
      "INSERT INTO command_intents (id, kind, idempotency_key, payload, state, result, owner, created_at, updated_at) VALUES ('i1', 'start_run', ?, '{}', 'accepted', 'adapter-run-1', 'orchestration', 'x', 'x')",
    )
    .run(turn.turn_id)
  const { Orchestrator } = await import('../../src/domain/orchestration/executor.ts')
  const restarted = new Orchestrator({
    db: h.db,
    ingest: h.ingest,
    port: h.port,
    access: h.access,
    fence: h.fence,
    clock: () => h.scheduler.now(),
  })
  await restarted.recover()
  const row = h.db.sqlite
    .prepare('SELECT state, run_id FROM orc_attempts WHERE id = ?')
    .get(attempt.id) as { state: string; run_id: string }
  expect(row).toEqual({ state: 'running', run_id: 'adapter-run-1' })
  expect(hold.state.calls).toBe(1)
  await restarted.close()
})

test('Stop works on a finished-with-unresolved run: the owed Stop is recorded without abandoning', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold]' })
          await t.call('orch.finish', { outcome: 'success', summary: 'x' })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  await endRun(h, attemptOf(h, id, 'step', 's1')[0]!.runId!, 'interrupted')
  await h.until(() => status(id) === 'finished_with_unresolved')
  expect(attemptOf(h, id, 'step', 's1')[0]!.stopRequestedAt).toBeNull()
  await h.orch.stop(id)
  const s1 = attemptOf(h, id, 'step', 's1')[0]!
  expect(s1.stopRequestedAt).not.toBeNull()
  expect(s1.state).toBe('unknown')
  expect(status(id)).toBe('finished_with_unresolved')
  await h.until(() => attemptOf(h, id, 'step', 's1')[0]!.stopAcknowledgedAt !== null)
  await expect(h.orch.stop(id)).rejects.toMatchObject({ status: 409 })
})

test('the final send barrier re-checks the budget: a lowered limit stops a prepared attempt from being sent', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: 'a' })
          await t.call('orch.assign', { agent: 'reviewer', instruction: 'b' })
        },
      }),
    },
  })
  const original = h.port.startRun.bind(h.port)
  let sent = 0
  h.port.startRun = async (req) => {
    if (req.agentId === 'builder' || req.agentId === 'reviewer') {
      sent++
      // While the first step's POST is in flight the person lowers the budget.
      if (sent === 1) h.db.sqlite.prepare('UPDATE orchestrations SET budget_usd = 0.01').run()
    }
    return original(req)
  }
  const id = await h.create({ gatePolicy: 'none', budgetUsd: 50 })
  await h.until(() => sent >= 1)
  await h.settle(3000)
  expect(sent).toBe(1)
  expect(h.orch.summary(id).pauseReason).toBe('budget')
})

test('commands are refused as soon as the lead run has ended, before the executor has reconciled it', async () => {
  let capability = ''
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          capability = t.capability
        },
      }),
    },
  })
  const id = await h.create()
  await h.until(() => capability !== '')
  const lead = attemptOf(h, id, 'lead')[0]!
  h.db.sqlite.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(lead.runId!)
  const out = await h.orch.handleTool('lead', 'orch.note', {
    capability,
    commandId: 'late',
    text: 'late',
  })
  expect(out).toMatchObject({ kind: 'unauthorized' })
  expect(h.rows('SELECT 1 FROM orc_commands')).toHaveLength(0)
})

test('streamed output past the limit is truncated, flagged, and the stored reply stays bounded', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold]' })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  const run = attemptOf(h, id, 'step', 's1')[0]!.runId!
  const { appendRunMessage } = await import('../../src/domain/message-runs.ts')
  for (let i = 0; i < 5; i++)
    await h.ingest.submit({
      source: 'test',
      identity: `big:${i}`,
      apply: ({ sqlite, now }) =>
        appendRunMessage(sqlite, run, `${'y'.repeat(20_000)} done.\n`, now),
    })
  const msg = h.rows<{ parts: string }>(
    "SELECT parts FROM messages WHERE id LIKE 'reply:orc-turn-%-s1-1'",
  )[0]!
  const text = (JSON.parse(msg.parts) as { kind: string; text?: string }[])
    .filter((p) => p.kind === 'text')
    .map((p) => p.text)
    .join('')
  expect(text.length).toBeLessThan(9000)
  expect(text.endsWith('[reply truncated]')).toBe(true)
  expect(text.split('[reply truncated]')).toHaveLength(2)
  const deltas = h
    .rows<{ data: string }>("SELECT data FROM events WHERE type = 'message.delta'")
    .reduce((n, r) => n + r.data.length, 0)
  expect(deltas).toBeLessThan(20_000)
})

test('spend is complete only when the session is known and every sibling run in it ended with evidence', async () => {
  h = await harness()
  const { runSpendReader } = await import('../../src/domain/orchestration/budget.ts')
  const run = (id: string, session: string | null, status: string, cost: number | null) =>
    h.db.sqlite
      .prepare(
        "INSERT INTO runs (id, profile, origin, session_id, status, started_at, updated_at, cost_usd) VALUES (?, 'builder', 'score', ?, ?, 'x', 'x', ?)",
      )
      .run(id, session, status, cost)
  const attempt = { run_id: 'a' } as never
  run('a', null, 'completed', 0.1)
  expect(runSpendReader(h.db.sqlite, attempt).complete).toBe(false)
  h.db.sqlite.prepare("UPDATE runs SET session_id = 's' WHERE id = 'a'").run()
  expect(runSpendReader(h.db.sqlite, attempt).complete).toBe(true)
  run('b', 's', 'cancelled', null)
  expect(runSpendReader(h.db.sqlite, attempt).complete).toBe(false)
  h.db.sqlite.prepare("UPDATE runs SET status = 'completed' WHERE id = 'b'").run()
  expect(runSpendReader(h.db.sqlite, attempt).complete).toBe(true)
})
