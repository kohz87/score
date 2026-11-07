import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ExecutionJournal } from '../src/domain/orchestration/journal.ts'
import { completeJournalHistory, resetJournalHistory } from '../src/history-reset.ts'
import { confirmCopy } from '../src/installation.ts'
import { read, root, run, seedSource } from './execution-freeze-helpers.ts'

test('a confirmed copy freezes, keeps everything it inherited untouched, survives a restore of its own backup and restarts', async () => {
  const home = join(root, 'home')
  mkdirSync(home)
  const first = await run(home)
  await first.close()
  seedSource(join(home, 'score.db'))
  const copy = join(root, 'home-copy')
  cpSync(home, copy, { recursive: true })
  rmSync(join(copy, 'score.pid'), { force: true })
  const confirmed = confirmCopy({ journalDir: join(root, 'journal'), home: copy })
  if (!confirmed.ok) throw new Error(confirmed.message)
  const ns = join(root, 'journal', confirmed.id)
  // The copy's pre-start database is "the backup of the confirmed copy" a person may restore later.
  const backup = join(root, 'copy-backup.db')
  cpSync(join(copy, 'score.db'), backup)
  // No retirement record is written on confirmation any more.
  const journal = new ExecutionJournal(ns, confirmed.id)
  const entries = journal.readOwn()
  if (!entries.ok) throw new Error(entries.reason)
  expect(entries.entries.map((e) => e.kind)).not.toContain('inherited-retired')

  const state = (db: string) => ({
    intent: read(db, "SELECT state FROM command_intents WHERE idempotency_key = 'turn-src'")[0],
    processes: read(db, "SELECT run_id FROM coding_processes WHERE run_id = 'run-src'"),
    attempt: read(db, "SELECT state FROM orc_attempts WHERE id = 'att-src'")[0],
    frozen: read(db, 'SELECT frozen_reason, fenced FROM orc_global')[0],
  })
  const untouched = {
    intent: { state: 'pending' },
    processes: [{ run_id: 'run-src' }],
    attempt: { state: 'created' },
  }
  const second = await run(copy)
  await second.close()
  expect(state(join(copy, 'score.db'))).toMatchObject({
    ...untouched,
    frozen: { frozen_reason: expect.stringMatching(/copy of installation/), fenced: 1 },
  })

  // A restored backup lost the flag: the registry still says this home is a copy, so the next start freezes again.
  for (const suffix of ['', '-wal', '-shm'])
    rmSync(join(copy, `score.db${suffix}`), { force: true })
  cpSync(backup, join(copy, 'score.db'))
  expect(state(join(copy, 'score.db')).frozen).toMatchObject({ frozen_reason: null })
  const third = await run(copy)
  await third.close()
  expect(state(join(copy, 'score.db'))).toMatchObject({
    ...untouched,
    frozen: { frozen_reason: expect.stringMatching(/copy of installation/), fenced: 1 },
  })
}, 60_000)

test('FU #6: a source’s reset and freeze records are not inherited, so they can never stand in for the copy’s own reset', async () => {
  const home = join(root, 'src-home')
  mkdirSync(home)
  const first = await run(home)
  const sourceId = first.installation && first.installation.ok ? first.installation.id : ''
  await first.close()
  const ns = join(root, 'journal', sourceId)
  // The source reset its own history once, and froze later.
  const journal = new ExecutionJournal(ns, sourceId)
  journal.append({ kind: 'checkpoint' })
  resetJournalHistory({
    journalDir: join(root, 'journal'),
    namespaceDir: ns,
    installationId: sourceId,
  })
  completeJournalHistory({
    namespaceDir: ns,
    installationId: sourceId,
    generation: (journal.historyState() as { generation: string | null }).generation ?? 'unused',
  })
  new ExecutionJournal(ns, sourceId).append({ kind: 'execution-freeze', reason: 'source froze' })
  const copy = join(root, 'src-copy')
  cpSync(home, copy, { recursive: true })
  rmSync(join(copy, 'score.pid'), { force: true })
  const confirmed = confirmCopy({ journalDir: join(root, 'journal'), home: copy })
  if (!confirmed.ok) throw new Error(confirmed.message)
  const inherited = new ExecutionJournal(
    join(root, 'journal', confirmed.id),
    confirmed.id,
  ).readOwn()
  if (!inherited.ok) throw new Error(inherited.reason)
  const kinds = inherited.entries.map((entry) => entry.kind)
  expect(kinds).not.toContain('history-reset')
  expect(kinds).not.toContain('history-reset-complete')
  expect(kinds).not.toContain('execution-freeze')
})
