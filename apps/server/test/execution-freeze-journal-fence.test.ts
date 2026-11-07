import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { CodingJournal } from '../src/domain/orchestration/coding-journal.ts'
import { codingProjection } from '../src/domain/orchestration/coding-checkpoint.ts'
import { GlobalFenceStore } from '../src/domain/orchestration/fence.ts'
import {
  ExecutionJournal,
  HISTORY_MARKER_FILE,
  JOURNAL_FILE,
} from '../src/domain/orchestration/journal.ts'
import { REASON, again, fenceOf, fullReset, root } from './execution-freeze-helpers.ts'

test('the person-facing sentence, and an unresolved installation freezing with its own instructions', () => {
  const dir = join(root, 'sentence')
  mkdirSync(dir)
  const { store, database } = fenceOf(dir, 'ns-id')
  expect(store.executionFrozen()).toBeNull()
  expect(store.frozenNotice()).toBeNull()
  store.setHardBlock(
    'This home is at a path Score does not know. Run `score installation confirm-copy`.',
  )
  expect(store.executionFrozen()).toMatch(/does not know/)
  expect(store.frozenNotice()).toMatch(/^Score is holding all agent work: This home is at a path/)
  // Its own instructions: reset-history is not the way out of an unresolved installation.
  expect(store.frozenNotice()).not.toMatch(REASON)
  store.freeze('the execution journal does not exist')
  store.setHardBlock(null)
  expect(store.frozenNotice()).toBe(
    'Score is holding all agent work: the execution journal does not exist. Run scripts/score installation reset-history to continue.',
  )
  database.close()
})

test('a missing journal freezes, and the freeze outlives the restart that recreates the journal; the lift is refused', () => {
  const dir = join(root, 'fence')
  mkdirSync(dir)
  const { journal, store, database } = fenceOf(dir, 'ns-id')
  expect(store.startupCheck()).toEqual({ fenced: false, reasons: [] }) // genuinely fresh
  journal.append({
    kind: 'send_started',
    attemptId: 'a1',
    orchestrationId: 'o1',
    attemptKind: 'step',
    agentId: 'builder',
    generation: 0,
  })
  expect(existsSync(join(dir, 'ns', HISTORY_MARKER_FILE))).toBe(true)
  rmSync(join(dir, 'ns', JOURNAL_FILE))
  const second = again(dir, 'ns-id', database)
  expect(second.startupCheck()).toMatchObject({ fenced: true, reasons: ['journal_missing'] })
  expect(second.executionFrozen()).toMatch(/history\.json/)
  // A later start (the journal file may exist again by then) is frozen without detecting anything.
  const third = again(dir, 'ns-id', database)
  expect(third.executionFrozen()).toMatch(/history\.json/)
  expect(() => third.lift(third.view().revision, 'checked')).toThrow(REASON)
  expect(third.view().fenced).toBe(true)
  database.close()
})

test('a missing journal with launch folders present freezes; an empty launch folder is not evidence', () => {
  const dir = join(root, 'fence2')
  mkdirSync(join(dir, 'ns', 'launches', 'empty'), { recursive: true })
  const { store, database } = fenceOf(dir, 'ns-id')
  expect(store.startupCheck()).toEqual({ fenced: false, reasons: [] })
  mkdirSync(join(dir, 'ns', 'launches', 'L1'), { recursive: true })
  writeFileSync(join(dir, 'ns', 'launches', 'L1', 'ended.json'), '{}')
  const second = again(dir, 'ns-id', database)
  expect(second.startupCheck()).toMatchObject({ fenced: true, reasons: ['journal_missing'] })
  expect(second.executionFrozen()).toMatch(/L1/)
  database.close()
})

test('a launch folder the journal has no launch for freezes even though the journal exists, and no lift ever accounts for it', () => {
  const dir = join(root, 'fence3')
  mkdirSync(dir)
  const { journal, store, database } = fenceOf(dir, 'ns-id')
  const coding = new CodingJournal(journal)
  expect(
    coding.requestLaunch({ launchId: 'known', runId: 'r', turnId: 't', generation: 1 }).ok,
  ).toBe(true)
  mkdirSync(join(dir, 'ns', 'launches', 'known'), { recursive: true })
  writeFileSync(join(dir, 'ns', 'launches', 'known', 'x.json'), '{}')
  mkdirSync(join(dir, 'ns', 'launches', 'stray'), { recursive: true })
  writeFileSync(join(dir, 'ns', 'launches', 'stray', 'x.json'), '{}')
  const result = store.startupCheck()
  expect(result.fenced).toBe(true)
  expect(result.reasons).toContain('journal_truncated')
  expect(store.executionFrozen()).toMatch(/stray/)
  expect(store.view().items.map((item) => item.ref)).toContain('launch-folder:stray')
  expect(store.view().items.map((item) => item.ref)).not.toContain('launch-folder:known')
  // The lift is refused, and a restart after the stray folder's time still reports it (no timestamp acceptance).
  expect(() => store.lift(store.view().revision, undefined)).toThrow(REASON)
  const restart = again(dir, 'ns-id', database)
  expect(restart.startupCheck().reasons).toContain('journal_truncated')
  expect(restart.view().items.map((item) => item.ref)).toContain('launch-folder:stray')
  database.close()
})

test('a journal truncated to an empty file or an older prefix, with receipts and rows surviving, freezes (re-review 4 #5)', () => {
  const dir = join(root, 'fence4')
  mkdirSync(dir)
  const { journal, store, database } = fenceOf(dir, 'ns-id')
  expect(store.startupCheck()).toEqual({ fenced: false, reasons: [] })
  const coding = new CodingJournal(journal)
  const project = codingProjection(database)
  expect(
    coding.requestLaunch({ launchId: 'L1', runId: 'r1', turnId: 't1', generation: 1 }, project).ok,
  ).toBe(true)
  mkdirSync(join(dir, 'ns', 'launches', 'L1'), { recursive: true })
  writeFileSync(join(dir, 'ns', 'launches', 'L1', 'released.json'), '{}')
  // The journal is cut back to nothing; SQLite and the receipts keep what happened.
  writeFileSync(join(dir, 'ns', JOURNAL_FILE), '')
  const restart = again(dir, 'ns-id', database)
  const result = restart.startupCheck()
  expect(result.reasons).toContain('journal_truncated')
  expect(restart.executionFrozen()).toMatch(/lost/)
  expect(() => restart.lift(restart.view().revision, undefined)).toThrow(REASON)
  database.close()
})

test('FU #3: a restored older database can’t forget a freeze the journal remembers, and an ordinary lift is refused', () => {
  const dir = join(root, 'sticky')
  mkdirSync(dir)
  const { journal, store, database } = fenceOf(dir, 'ns-id')
  journal.append({
    kind: 'send_started',
    attemptId: 'a1',
    orchestrationId: 'o1',
    attemptKind: 'step',
    agentId: 'builder',
    generation: 0,
  })
  rmSync(join(dir, 'ns', JOURNAL_FILE))
  expect(store.startupCheck().reasons).toContain('journal_missing')
  // The probe of re-review 5: a database from before the freeze is put back while the journal's record stays.
  database.sqlite.exec(
    'UPDATE orc_global SET frozen_reason = NULL, fenced = 0, reason = NULL WHERE id = 1',
  )
  const restored = again(dir, 'ns-id', database)
  expect(restored.executionFrozen()).toMatch(/history\.json/)
  expect(restored.startupCheck().fenced).toBe(false) // nothing new is detected: the freeze is what remains
  expect(restored.executionFrozen()).not.toBeNull()
  database.sqlite.exec("UPDATE orc_global SET fenced = 1, reason = 'journal_mismatch' WHERE id = 1")
  expect(() => restored.lift(restored.view().revision, 'looks fine')).toThrow(REASON)
  // A completed reset supersedes it.
  fullReset(dir, database)
  expect(again(dir, 'ns-id', database).executionFrozen()).toBeNull()
  database.close()
})

test('FU #3: an unreadable journal is frozen, whatever the database says', () => {
  const dir = join(root, 'unreadable')
  mkdirSync(join(dir, 'ns'), { recursive: true })
  const { store, database } = fenceOf(dir, 'ns-id')
  writeFileSync(join(dir, 'ns', JOURNAL_FILE), 'garbage\n')
  expect(store.executionFrozen()).toMatch(/cannot be read/)
  expect(() => store.lift(store.view().revision, undefined)).toThrow()
  database.close()
})

test('FU #3: an orchestration-only database whose journal lost the dispatches freezes', () => {
  const dir = join(root, 'orc-only')
  mkdirSync(dir)
  const { journal, store, database } = fenceOf(dir, 'ns-id')
  expect(store.startupCheck()).toEqual({ fenced: false, reasons: [] })
  database.sqlite.exec('PRAGMA foreign_keys = OFF')
  database.sqlite.exec(`
    INSERT INTO orchestrations (id, title, goal, lead_agent_id, lead_incarnation, allowed_agents, room_id, brief_id,
      gate_policy, max_steps, max_lead_turns, max_concurrent_steps, lead_turn_estimate_usd, step_estimate_usd, status,
      acknowledgement, preflight, reserve_bytes, created_at, updated_at)
      VALUES ('o1', 't', 'g', 'lead', 'i', '[]', 'r', 'b', 'none', 1, 1, 1, 1, 1, 'running', '{}', '{}', 0, 'x', 'x');
    INSERT INTO orc_attempts (id, orchestration_id, kind, n, agent_id, agent_incarnation, session_id, turn_id, message_id,
      state, input, dispatch_generation, created_at, updated_at)
      VALUES ('att1', 'o1', 'lead', 1, 'lead', 'i', 's', 'turn-att', 'm', 'running', '', 1, '2026-10-13T00:00:00.000Z', 'x');`)
  // The journal survives with something older and no dispatch of att1.
  journal.append({ kind: 'checkpoint' })
  const restart = again(dir, 'ns-id', database)
  expect(restart.startupCheck().reasons).toContain('journal_truncated')
  expect(restart.executionFrozen()).toMatch(/att1/)
  database.close()
})

test('FT #6: an established journal that disappears while Score runs holds all agent work, and recreating it does not thaw', () => {
  const dir = join(root, 'vanish')
  mkdirSync(dir)
  const { journal, store, database } = fenceOf(dir, 'ns-id')
  expect(store.startupCheck()).toEqual({ fenced: false, reasons: [] })
  journal.append({
    kind: 'send_started',
    attemptId: 'a1',
    orchestrationId: 'o1',
    attemptKind: 'step',
    agentId: 'builder',
    generation: 1,
  })
  // Same server incarnation: the file was there and the predicate has seen it.
  expect(store.executionFrozen()).toBeNull()
  rmSync(join(dir, 'ns', JOURNAL_FILE))
  expect(store.executionFrozenIn(database.sqlite)).toMatch(/disappeared/)
  expect(store.executionFrozen()).toMatch(/disappeared/)
  // Only the freeze record recreates the file (verification #5); nothing ordinary can.
  expect(existsSync(join(dir, 'ns', JOURNAL_FILE))).toBe(true)
  expect(store.executionFrozen()).toMatch(/disappeared/)
  expect(again(dir, 'ns-id', database).executionFrozen()).toMatch(/disappeared/)
  database.close()
})

test('verification #5: after the loss is seen, an ordinary append cannot recreate the journal, and a file recreated by another writer does not thaw', () => {
  const dir = join(root, 'vanish-latch')
  mkdirSync(dir)
  const { journal, store, database } = fenceOf(dir, 'ns-id')
  expect(store.startupCheck()).toEqual({ fenced: false, reasons: [] })
  const body = {
    kind: 'send_started',
    attemptId: 'a1',
    orchestrationId: 'o1',
    attemptKind: 'step',
    agentId: 'builder',
    generation: 1,
  } as const
  journal.append(body)
  expect(store.executionFrozen()).toBeNull()
  rmSync(join(dir, 'ns', JOURNAL_FILE))
  // The probe: an ordinary append (a team resume) right after the loss.
  expect(() => journal.append({ ...body, attemptId: 'a2' })).toThrow(/disappeared/)
  expect(existsSync(join(dir, 'ns', JOURNAL_FILE))).toBe(false)
  // Another writer recreates the file: the latch holds.
  writeFileSync(join(dir, 'ns', JOURNAL_FILE), '')
  expect(store.executionFrozenIn(database.sqlite)).toMatch(/disappeared/)
  expect(store.executionFrozen()).toMatch(/disappeared/)
  database.close()
})

test('verification #1: the freeze predicate answers inside a caller transaction (the bridge lease) instead of failing', () => {
  const dir = join(root, 'nested')
  mkdirSync(dir)
  const { store, database } = fenceOf(dir, 'ns-id')
  expect(store.startupCheck()).toEqual({ fenced: false, reasons: [] })
  expect(database.tx(() => store.executionFrozen())).toBeNull()
  database.tx((sqlite) =>
    sqlite.prepare("UPDATE orc_global SET frozen_reason = 'a test freeze' WHERE id = 1").run(),
  )
  expect(database.tx(() => store.executionFrozen())).toBe('a test freeze')
  expect(database.read(() => store.executionFrozen())).toBe('a test freeze')
  database.close()
})

test('FT #6: a journal truncated back to an older generation of an attempt freezes, matching the id is not enough', () => {
  const dir = join(root, 'generation-truncated')
  mkdirSync(dir)
  const { journal, store, database } = fenceOf(dir, 'ns-id')
  expect(store.startupCheck()).toEqual({ fenced: false, reasons: [] })
  database.sqlite.exec('PRAGMA foreign_keys = OFF')
  database.sqlite.exec(`
    INSERT INTO orchestrations (id, title, goal, lead_agent_id, lead_incarnation, allowed_agents, room_id, brief_id,
      gate_policy, max_steps, max_lead_turns, max_concurrent_steps, lead_turn_estimate_usd, step_estimate_usd, status,
      acknowledgement, preflight, reserve_bytes, created_at, updated_at)
      VALUES ('o1', 't', 'g', 'lead', 'i', '[]', 'r', 'b', 'none', 1, 1, 1, 1, 1, 'running', '{}', '{}', 0, 'x', 'x');
    INSERT INTO orc_attempts (id, orchestration_id, kind, n, agent_id, agent_incarnation, session_id, turn_id, message_id,
      state, input, dispatch_generation, created_at, updated_at)
      VALUES ('att1', 'o1', 'step', 1, 'builder', 'i', 's', 'turn-att', 'm', 'running', '', 2, '2026-10-13T00:00:00.000Z', 'x');`)
  // The journal still holds generation 1 (sent, then refused) but lost the second send.
  journal.append({
    kind: 'send_started',
    attemptId: 'att1',
    orchestrationId: 'o1',
    attemptKind: 'step',
    agentId: 'builder',
    generation: 1,
  })
  journal.append({ kind: 'send_refused', attemptId: 'att1', orchestrationId: 'o1', generation: 1 })
  const restart = again(dir, 'ns-id', database)
  expect(restart.startupCheck().reasons).toContain('journal_truncated')
  expect(restart.executionFrozen()).toMatch(/att1/)
  // The matching generation is no loss.
  database.sqlite.exec('UPDATE orc_attempts SET dispatch_generation = 1')
  const clean = new GlobalFenceStore(database, new ExecutionJournal(join(dir, 'ns'), 'ns-id'))
  database.sqlite.exec('UPDATE orc_global SET frozen_reason = NULL, fenced = 0, reason = NULL')
  expect(clean.startupCheck().reasons).not.toContain('journal_truncated')
  database.close()
})
