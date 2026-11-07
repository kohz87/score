import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { migrate, openDatabase } from '../../src/db/index.ts'
import { readOrch } from '../../src/domain/orchestration/store.ts'
import { summaryOf } from '../../src/domain/orchestration/views.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { runDraft } from '../../src/hermes/index.ts'
import { runRecoveredObservation } from '../../src/hermes/live/translate.ts'
import { detail, startHarness, status } from './fix-h-helpers.ts'
import { attemptOf } from './harness.ts'
import { migrationsDir, tempDir } from './harness-db.ts'

test('fix-h 1: a run recovered from session text (404 + matching reply) shows its text but is not termination evidence', async () => {
  const h = await startHarness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold] write it' })
          await t.call('orch.assign', { agent: 'reviewer', instruction: 'check it', after: ['s1'] })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  const attempt = attemptOf(h, id, 'step', 's1')[0]!
  // Hermes forgot the run; the live follower found a matching assistant reply in the session history.
  await h.ingest.submit(
    runRecoveredObservation(
      { profile: 'builder', runId: attempt.runId!, credentialGeneration: 1 },
      'Recovered answer text',
    ),
  )
  expect(
    h.rows<{ status: string; terminal_source: string }>(
      'SELECT status, terminal_source FROM runs WHERE id = ?',
      attempt.runId!,
    ),
  ).toEqual([{ status: 'completed', terminal_source: 'recovered' }])
  await h.settle(5000)
  const after = attemptOf(h, id, 'step', 's1')[0]!
  expect(after.state).toBe('unknown')
  expect(after.unknownReason).toBe('recovered_text_only')
  const d = detail(id)
  expect(d.stepsList.find((s) => s.id === 's1')!.status).toBe('unknown')
  expect(d.unconfirmed).toEqual([after.id])
  // No successor was admitted and the result was not accepted.
  expect(attemptOf(h, id, 'step', 's2')).toHaveLength(0)
  expect(
    h.rows('SELECT result FROM orc_steps WHERE id = ? AND result IS NOT NULL', 's1'),
  ).toHaveLength(0)
  expect(status(id)).not.toBe('succeeded')
  // The person still sees the text (chat behaviour is unchanged).
  expect(
    h.rows<{ output: string }>('SELECT output FROM runs WHERE id = ?', attempt.runId!)[0]!.output,
  ).toBe('Recovered answer text')
})

test('fix-w 3: a completed run whose process group was never proven gone is not termination evidence', async () => {
  const h = await startHarness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold] write it' })
          await t.call('orch.assign', { agent: 'reviewer', instruction: 'check it', after: ['s1'] })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  const attempt = attemptOf(h, id, 'step', 's1')[0]!
  await h.ingest.submit({
    source: 'test',
    identity: `unconfirmed:${attempt.runId}`,
    apply({ sqlite, now }) {
      sqlite
        .prepare(
          "UPDATE runs SET status = 'completed', terminal_source = 'unconfirmed', output = 'Done', ended_at = ?, version = version + 1 WHERE id = ?",
        )
        .run(now, attempt.runId!)
      return [runDraft(sqlite, attempt.runId!)]
    },
  })
  await h.settle(5000)
  const after = attemptOf(h, id, 'step', 's1')[0]!
  expect(after.state).toBe('unknown')
  expect(attemptOf(h, id, 'step', 's2')).toHaveLength(0)
  expect(status(id)).not.toBe('succeeded')
})

test('fix-h 4: upgrading backfills terminal_source and turns attempts that ended on recovered text into unknown', () => {
  const tmp = tempDir('orc-upgrade-')
  try {
    const before = join(tmp.dir, 'migrations-before')
    mkdirSync(before)
    for (const name of readdirSync(migrationsDir))
      if (Number(name.slice(0, 4)) < 49) copyFileSync(join(migrationsDir, name), join(before, name))
    const db = openDatabase(join(tmp.dir, 'score.db'))
    migrate(db, before)
    const at = '2026-10-10T10:00:00.000Z'
    db.sqlite.exec('PRAGMA foreign_keys = OFF')
    const run = db.sqlite.prepare(
      "INSERT INTO runs (id, profile, origin, status, started_at, updated_at, ended_at, output) VALUES (?, 'builder', 'score', ?, ?, ?, ?, 'text')",
    )
    run.run('r-rec', 'completed', at, at, at)
    run.run('r-rt', 'completed', at, at, at)
    run.run('r-open', 'running', at, at, null)
    db.sqlite
      .prepare('INSERT INTO gaps (source, run_id, from_ts, to_ts, reason) VALUES (?, ?, ?, ?, ?)')
      .run(
        'run-sse:builder',
        'r-rec',
        at,
        at,
        'Run record expired; the result was recovered from the session history',
      )
    db.sqlite
      .prepare(
        `INSERT INTO orchestrations (id, title, goal, lead_agent_id, lead_incarnation, allowed_agents, room_id, brief_id,
         gate_policy, max_steps, max_lead_turns, max_concurrent_steps, lead_turn_estimate_usd, step_estimate_usd, status,
         acknowledgement, preflight, reserve_bytes, created_at, updated_at)
         VALUES ('orc-up', 't', 'g', 'lead', 'i', '["builder"]', 'r', 'b', 'none', 5, 5, 2, 1, 1, 'running', '{}', '{}', 0, ?, ?)`,
      )
      .run(at, at)
    const step = db.sqlite.prepare(
      `INSERT INTO orc_steps (orchestration_id, id, seq, agent_id, agent_incarnation, instruction, after_steps, status, estimate_usd, result, result_revision, created_in_attempt, created_at, updated_at)
       VALUES ('orc-up', ?, ?, 'builder', 'i', 'x', ?, ?, 1, ?, ?, 'a0', ?, ?)`,
    )
    step.run('s1', 1, '[]', 'succeeded', 'accepted text', 1, at, at)
    step.run('s2', 2, '[]', 'succeeded', 'real result', 1, at, at)
    step.run('s3', 3, '["s1"]', 'queued', null, 0, at, at)
    const attempt = db.sqlite.prepare(
      `INSERT INTO orc_attempts (id, orchestration_id, kind, step_id, n, agent_id, agent_incarnation, session_id, turn_id,
       message_id, state, input, run_id, evidence, terminated_at, settled, sent_at, created_at, updated_at)
       VALUES (?, 'orc-up', 'step', ?, 1, 'builder', 'i', ?, ?, ?, ?, '', ?, ?, ?, 1, ?, ?, ?)`,
    )
    attempt.run(
      'a-rec',
      's1',
      'sess-1',
      'turn-1',
      'm1',
      'terminated',
      'r-rec',
      'completed',
      at,
      at,
      at,
      at,
    )
    attempt.run(
      'a-rt',
      's2',
      'sess-2',
      'turn-2',
      'm2',
      'terminated',
      'r-rt',
      'completed',
      at,
      at,
      at,
      at,
    )
    db.sqlite.exec('PRAGMA foreign_keys = ON')
    migrate(db, migrationsDir)
    const source = (id: string) =>
      (
        db.sqlite.prepare('SELECT terminal_source AS s FROM runs WHERE id = ?').get(id) as {
          s: string | null
        }
      ).s
    expect([source('r-rec'), source('r-rt'), source('r-open')]).toEqual([
      'recovered',
      'runtime',
      null,
    ])
    const state = (id: string) =>
      db.sqlite
        .prepare('SELECT state, unknown_reason, evidence FROM orc_attempts WHERE id = ?')
        .get(id)
    expect(state('a-rec')).toMatchObject({
      state: 'unknown',
      unknown_reason: 'recovered_text_only',
      evidence: null,
    })
    expect(state('a-rt')).toMatchObject({ state: 'terminated', evidence: 'completed' })
    // The accepted result stays visible, but the unknown attempt fences the run so s3 is not admitted.
    expect(
      db.sqlite.prepare("SELECT status, result FROM orc_steps WHERE id = 's1'").get(),
    ).toMatchObject({
      status: 'succeeded',
      result: 'accepted text',
    })
    const summary = summaryOf(db.sqlite, readOrch(db.sqlite, 'orc-up')!)
    expect(summary.needsYou).toContainEqual({ kind: 'unknown', attemptId: 'a-rec' })
    db.close()
  } finally {
    tmp.cleanup()
  }
})
