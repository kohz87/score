import { cpSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { migrate } from '../src/db/index.ts'
import { dir, migrationDir, open } from './db-helpers.ts'

test('gate #4 migration bounds legacy uncertain admissions by creation time; receipts enforce the 64 KB JSON cap', () => {
  const copy = join(dir, 'gate-upgrade')
  mkdirSync(copy)
  for (const name of [
    '0001_infra.sql',
    '0002_ingest_floors.sql',
    '0003_runs.sql',
    '0004_bridge.sql',
    '0005_approvals.sql',
    '0006_kanban_denials.sql',
  ])
    cpSync(join(migrationDir, name), join(copy, name))
  const db = open()
  migrate(db, copy)
  const at = '2026-10-01T00:00:00.000Z'
  for (const state of ['sent', 'unknown', 'pending'])
    db.sqlite
      .prepare(
        "INSERT INTO command_intents (id, kind, idempotency_key, payload, state, created_at, updated_at) VALUES (?, 'start_run', ?, '{}', ?, ?, ?)",
      )
      .run(state, state, state, at, at)
  db.sqlite
    .prepare(
      `INSERT INTO producers (id, profile, incarnation, pid, isolation, plugin_version, private_apis, token_hash,
       token_expires_at, created_at, last_seen_at, gateway_approvals)
       VALUES ('p1', 'builder', 'inc-00000001', 1, 'in_process', '0.0.9', '{}', ?, 0, ?, ?, 1)`,
    )
    .run('a'.repeat(64), at, at)
  cpSync(join(migrationDir, '0007_gate_fixes.sql'), join(copy, '0007_gate_fixes.sql'))
  migrate(db, copy)
  // Producers qualified before 0007 must re-qualify at their next hello (gate follow-up).
  expect(db.sqlite.prepare('SELECT gateway_approvals FROM producers').get()).toEqual({
    gateway_approvals: 0,
  })
  expect(
    db.sqlite.prepare('SELECT id, first_sent_at FROM command_intents ORDER BY id').all(),
  ).toEqual([
    { id: 'pending', first_sent_at: null },
    { id: 'sent', first_sent_at: at },
    { id: 'unknown', first_sent_at: at },
  ])
  const insert = db.sqlite.prepare(
    "INSERT INTO request_receipts (key, route, body_sha256, status, response, created_at) VALUES (?, '/route', 'hash', 200, ?, ?)",
  )
  expect(() => insert.run('invalid', 'not JSON', at)).toThrow()
  expect(() => insert.run('oversized', JSON.stringify('x'.repeat(65536)), at)).toThrow()
  expect(() => insert.run('bounded', JSON.stringify('x'.repeat(65534)), at)).not.toThrow()
  for (const name of ['0008_rooms.sql', '0009_agent_styles.sql', '0010_tasks.sql'])
    cpSync(join(migrationDir, name), join(copy, name))
  migrate(db, copy)
  expect(
    db.sqlite.prepare("SELECT status, response FROM request_receipts WHERE key = 'bounded'").get(),
  ).toEqual({ status: 200, response: JSON.stringify('x'.repeat(65534)) })
  expect(() =>
    insert.run('oversized-after-upgrade', JSON.stringify('x'.repeat(65536)), at),
  ).toThrow()
})

test('migration 0026 does not treat a pending pause hold as a confirmed legacy block', () => {
  const copy = join(dir, 'legacy-holds')
  mkdirSync(copy)
  const names = readdirSync(migrationDir).sort()
  for (const name of names.filter((item) => item < '0024'))
    cpSync(join(migrationDir, name), join(copy, name))
  const db = open()
  migrate(db, copy)
  const at = '2026-10-01T00:00:00.000Z'
  for (const state of ['pending', 'held'])
    db.sqlite
      .prepare(
        'INSERT INTO agent_paused_tasks (agent_id, task_id, blocked_at, state) VALUES (?, ?, ?, ?)',
      )
      .run('builder', state, at, state)
  db.sqlite.exec('UPDATE agent_paused_tasks SET legacy = 1')
  for (const name of names.filter((item) => item >= '0024'))
    cpSync(join(migrationDir, name), join(copy, name))
  migrate(db, copy)
  expect(
    db.sqlite.prepare('SELECT task_id, legacy FROM agent_paused_tasks ORDER BY task_id').all(),
  ).toEqual([
    { task_id: 'held', legacy: 1 },
    { task_id: 'pending', legacy: 0 },
  ])
})
