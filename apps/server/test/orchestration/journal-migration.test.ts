import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrateLegacyJournal } from '../../src/domain/orchestration/journal-migration.ts'
import {
  ExecutionJournal,
  JOURNAL_FILE,
  RESTORE_MARKER_FILE,
  journalLine,
  journalScope,
  type JournalEntry,
  type JournalEntryBody,
} from '../../src/domain/orchestration/journal.ts'
import { CodingJournal } from '../../src/domain/orchestration/coding-journal.ts'
import { resolveInstallation, restoreMarkerDir } from '../../src/installation.ts'

// 7.7a design v7 §2 [v5 6]: migration of the path-scoped journal into the installation namespace.

let root: string
let journalDir: string
let home: string
let scope: string
let id: string
let nsDir: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'score-mig-'))
  journalDir = join(root, 'journal')
  home = join(root, 'home')
  mkdirSync(home)
  scope = journalScope(home)
  const resolved = resolveInstallation({ journalDir, home })
  if (!resolved.ok) throw new Error(resolved.message)
  id = resolved.id
  nsDir = resolved.namespaceDir
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const send = (attemptId: string): JournalEntryBody => ({
  kind: 'send_started',
  attemptId,
  orchestrationId: 'o1',
  attemptKind: 'step',
  agentId: 'builder',
  generation: 1,
})
const seedLegacy = () => {
  const mine = new ExecutionJournal(journalDir, scope)
  const other = new ExecutionJournal(journalDir, 'someone-else')
  mine.append(send('a1'))
  other.append(send('x1'))
  mine.append({ kind: 'global_fence', action: 'set', fenceSeq: 1, reason: 'test' })
  mine.append(send('a2'))
  return { mine, other }
}
const migrate = (extra: Partial<Parameters<typeof migrateLegacyJournal>[0]> = {}) =>
  migrateLegacyJournal({
    journalDir: journalDir.replace(/\/$/, ''),
    homeScope: scope,
    installationId: id,
    namespaceDir: nsDir,
    ...extra,
  })
const nsEntries = () => {
  const read = new ExecutionJournal(nsDir, id).read()
  if (!read.ok) throw new Error(read.reason)
  return read.entries
}

test('this home’s records are copied with their numbers, scope translated, and a cutover is recorded in the legacy file', () => {
  seedLegacy()
  expect(migrate()).toMatchObject({ ok: true, state: 'migrated', copied: 3 })
  const entries = nsEntries()
  expect(entries.map((e) => [e.n, e.kind, e.scope])).toEqual([
    [1, 'send_started', id],
    [3, 'global_fence', id],
    [4, 'send_started', id],
  ])
  const legacy = new ExecutionJournal(journalDir, scope).read()
  if (!legacy.ok) throw new Error(legacy.reason)
  const cutover = legacy.entries.find((e) => e.kind === 'cutover')
  expect(cutover).toMatchObject({ scope, installationId: id, namespace: id, copiedThrough: 4 })
  // Another home's records stay where they are, untouched.
  expect(legacy.entries.filter((e) => e.scope === 'someone-else')).toHaveLength(1)
  // The namespace journal continues the numbering.
  const journal = new ExecutionJournal(nsDir, id)
  expect(journal.append(send('a3')).n).toBe(5)
})

test('after the cutover every writer refuses the legacy path for this home, even one opened before it (others are not affected)', () => {
  const { mine, other } = seedLegacy()
  migrate()
  expect(() => mine.append(send('late'))).toThrow(/read-only witness/)
  expect(() => new ExecutionJournal(journalDir, scope).append(send('late'))).toThrow(
    /read-only witness/,
  )
  expect(() => other.append(send('x2'))).not.toThrow()
})

test('running the migration again changes nothing (idempotent)', () => {
  seedLegacy()
  migrate()
  const before = readFileSync(join(nsDir, JOURNAL_FILE), 'utf8')
  const legacyBefore = readFileSync(join(journalDir, JOURNAL_FILE), 'utf8')
  expect(migrate()).toMatchObject({ ok: true, state: 'already' })
  expect(readFileSync(join(nsDir, JOURNAL_FILE), 'utf8')).toBe(before)
  expect(readFileSync(join(journalDir, JOURNAL_FILE), 'utf8')).toBe(legacyBefore)
})

for (const step of ['journal-copied', 'marker-moved'] as const)
  test(`an interruption after "${step}" converges on the next run from the snapshot`, () => {
    seedLegacy()
    writeFileSync(
      join(journalDir, RESTORE_MARKER_FILE),
      JSON.stringify({ scope, at: '2026-10-12T10:00:00.000Z', backup: '/b' }),
    )
    expect(() =>
      migrate({
        afterStep: (s) => {
          if (s === step) throw new Error('crash')
        },
      }),
    ).toThrow('crash')
    // No cutover yet: the legacy path is still writable for this home (nothing was lost, nothing is duplicated).
    expect(migrate()).toMatchObject({ ok: true, state: 'migrated' })
    expect(nsEntries().map((e) => e.n)).toEqual([1, 3, 4])
    expect(migrate()).toMatchObject({ ok: true, state: 'already' })
    const cutovers = readFileSync(join(journalDir, JOURNAL_FILE), 'utf8')
      .split('\n')
      .filter((line) => line.includes('"kind":"cutover"'))
    expect(cutovers).toHaveLength(1)
  })

test('a half-written copy (temp file left by a crash) is ignored and replaced', () => {
  seedLegacy()
  writeFileSync(join(nsDir, `${JOURNAL_FILE}.migrating`), 'partial')
  expect(migrate()).toMatchObject({ ok: true, state: 'migrated' })
  expect(nsEntries()).toHaveLength(3)
})

test('a namespace journal that disagrees with the snapshot is refused, not overwritten', () => {
  seedLegacy()
  const ns = new ExecutionJournal(nsDir, id)
  ns.append(send('different'))
  const result = migrate()
  expect(result).toMatchObject({ ok: false })
  expect(!result.ok && result.reason).toMatch(/already holds different records/)
})

test('a damaged legacy journal is refused (the caller fences) rather than copied', () => {
  seedLegacy()
  writeFileSync(
    join(journalDir, JOURNAL_FILE),
    readFileSync(join(journalDir, JOURNAL_FILE), 'utf8') + 'garbage\nmore\n',
  )
  const result = migrate()
  expect(result).toMatchObject({ ok: false })
  expect(existsSync(join(nsDir, JOURNAL_FILE))).toBe(false)
})

test('a cutover naming another installation is an ambiguity, refused', () => {
  seedLegacy()
  new ExecutionJournal(journalDir, scope).appendCutover({
    kind: 'cutover',
    installationId: 'c'.repeat(16),
    namespace: 'c'.repeat(16),
    copiedThrough: 4,
  })
  expect(migrate()).toMatchObject({ ok: false })
})

test('the restore marker for this home moves with the records, with the scope translated; other homes’ markers stay', () => {
  seedLegacy()
  writeFileSync(
    join(journalDir, RESTORE_MARKER_FILE),
    JSON.stringify({ scope, at: '2026-10-12T10:00:00.000Z', backup: '/b' }),
  )
  migrate()
  expect(existsSync(join(journalDir, RESTORE_MARKER_FILE))).toBe(false)
  const ns = new ExecutionJournal(nsDir, id)
  expect(ns.readRestoreMarker()).toMatchObject({ scope: id, backup: '/b' })
  // A marker for another home is left alone.
  writeFileSync(
    join(journalDir, RESTORE_MARKER_FILE),
    JSON.stringify({ scope: 'someone-else', at: '2026-10-12T10:00:00.000Z', backup: '/b' }),
  )
  migrate()
  expect(existsSync(join(journalDir, RESTORE_MARKER_FILE))).toBe(true)
})

test('restore.mjs follows the cutover: the marker goes to the namespace, not the legacy directory', () => {
  seedLegacy()
  migrate()
  expect(restoreMarkerDir(journalDir, home)).toBe(nsDir.replace(/\/$/, ''))
})

test('nothing to migrate: no namespace journal is created (a fresh journal stays fresh)', () => {
  new ExecutionJournal(journalDir, 'someone-else').append(send('x1'))
  expect(migrate()).toMatchObject({ ok: true, state: 'none' })
  expect(existsSync(join(nsDir, JOURNAL_FILE))).toBe(false)
})

test('a lost registry and manifests are recovered from the legacy cutover (never a new id)', () => {
  seedLegacy()
  migrate()
  rmSync(join(journalDir, 'installations.json'))
  rmSync(nsDir, { recursive: true })
  rmSync(join(home, 'installation.json'))
  const again = resolveInstallation({ journalDir, home })
  expect(again).toMatchObject({ ok: true, id, how: 'recovered' })
})

test('FX3 #11: a cutover is accepted only while its destination witness is still there', () => {
  seedLegacy()
  expect(migrate()).toMatchObject({ ok: true, state: 'migrated' })
  expect(migrate()).toMatchObject({ ok: true, state: 'already' })
  // The namespace journal is gone (a restored or damaged folder): fail closed.
  rmSync(join(nsDir, JOURNAL_FILE))
  expect(migrate()).toMatchObject({ ok: false, reason: expect.stringMatching(/missing/) })
  // Truncated: it no longer reaches the cutover's copied-through record.
  writeFileSync(join(nsDir, JOURNAL_FILE), '')
  expect(migrate()).toMatchObject({ ok: false, reason: expect.stringMatching(/lost/) })
})

test('FY2 #11: a surviving checkpoint does not stand in for a missing individual witness', () => {
  seedLegacy()
  const mine = new ExecutionJournal(journalDir, scope)
  // (a coding launch witnessed executing is part of the legacy history too)
  const legacyCoding = new CodingJournal(mine)
  const identity = { launchId: 'l1', runId: 'r1', turnId: 't1', generation: 1 }
  legacyCoding.requestLaunch(identity)
  legacyCoding.arm('l1', { unit: 'u', invocationId: 'i', cgroup: '/c' })
  legacyCoding.release('l1', () => true)
  expect(migrate()).toMatchObject({ ok: true, state: 'migrated' })
  const target = join(nsDir, JOURNAL_FILE)
  const good = readFileSync(target)
  const read = new ExecutionJournal(nsDir, id).readOwn()
  if (!read.ok) throw new Error(read.reason)
  const top = read.entries.at(-1)!
  // An older restored namespace holding only a checkpoint with the cutover's number: the sends are gone.
  writeFileSync(
    target,
    journalLine({ n: top.n, at: top.at, scope: id, kind: 'checkpoint' } as JournalEntry),
  )
  expect(migrate()).toMatchObject({ ok: false, reason: expect.stringMatching(/dispatch witness/) })
  // The dispatches survive but the coding launch's witness is gone behind a later record.
  const withoutCoding: JournalEntry[] = [
    ...read.entries.filter((e) => (e as { launchId?: string }).launchId === undefined),
    { n: top.n, at: top.at, scope: id, kind: 'checkpoint' },
  ]
  writeFileSync(target, Buffer.concat(withoutCoding.map(journalLine)))
  expect(migrate()).toMatchObject({ ok: false, reason: expect.stringMatching(/coding launch l1/) })
  // The intact copy, and the same copy after compaction folded it into tombstones, are still accepted.
  writeFileSync(target, good)
  expect(migrate()).toMatchObject({ ok: true, state: 'already' })
  new ExecutionJournal(nsDir, id).compact(() => true)
  expect(migrate()).toMatchObject({ ok: true, state: 'already' })
})

test('FZ3 #14: every authority-bearing record must survive the cutover (authorization, hold, remap, global fence, run handle)', () => {
  const mine = new ExecutionJournal(journalDir, scope)
  mine.append(send('a1'))
  mine.append({
    kind: 'authorization',
    orchestrationId: 'o1',
    budgetUsd: 1,
    deadlineAt: null,
    acceptUnknownSpend: false,
  })
  mine.append({ kind: 'hold', target: 'agent', agentId: 'builder', action: 'set' })
  mine.append({ kind: 'remap', orchestrationId: 'o1', agentId: 'builder', incarnation: 'inc-2' })
  mine.append({ kind: 'global_fence', action: 'set', fenceSeq: 1, reason: 'test' })
  mine.append({ kind: 'run_handle', attemptId: 'a1', runId: 'run-1' })
  expect(migrate()).toMatchObject({ ok: true, state: 'migrated' })
  const target = join(nsDir, JOURNAL_FILE)
  const good = readFileSync(target)
  const read = new ExecutionJournal(nsDir, id).readOwn()
  if (!read.ok) throw new Error(read.reason)
  const without = (kind: string, label: RegExp) => {
    // Each lost record is replaced by a checkpoint of the same number, so only the witness itself is missing.
    const kept = read.entries.map((e) =>
      e.kind === kind ? ({ n: e.n, at: e.at, scope: id, kind: 'checkpoint' } as JournalEntry) : e,
    )
    writeFileSync(target, Buffer.concat(kept.map(journalLine)))
    expect(migrate()).toMatchObject({ ok: false, reason: expect.stringMatching(label) })
    writeFileSync(target, good)
    expect(migrate()).toMatchObject({ ok: true, state: 'already' })
  }
  without('authorization', /authorization of o1/)
  without('hold', /hold of agent builder/)
  without('remap', /remap of builder in o1/)
  without('run_handle', /run handle of attempt a1/)
  without('global_fence', /global fence/)
  // A later authorization supersedes the legacy one (a person tightened it again here): accepted.
  new ExecutionJournal(nsDir, id).append({
    kind: 'authorization',
    orchestrationId: 'o1',
    budgetUsd: 0.5,
    deadlineAt: null,
    acceptUnknownSpend: false,
  })
  expect(migrate()).toMatchObject({ ok: true, state: 'already' })
})
