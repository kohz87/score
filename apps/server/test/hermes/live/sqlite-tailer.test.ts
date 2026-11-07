import { renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createTailer, incarnationOf, tailTaskEvents } from '../../../src/hermes/live/index.ts'
import { insertEvent } from '../../fixtures/hermes/sqlite-fixture.ts'
import { fixtures, installSqliteHooks, setup, sources, tailers } from './sqlite-helpers.ts'

installSqliteHooks()

test.each(sources)(
  '$kind tails carried timestamps and same-millisecond rows by ID exactly once',
  (source) => {
    const { db, tailer } = setup(source, 2)
    source.insert(db, 3000)
    const first = tailer.poll()
    expect(first.rows.map((row) => row.id)).toEqual([1])
    source.insert(db, 1000)
    source.insert(db, 1000)
    source.insert(db, 500)
    const second = tailer.poll(first.checkpoint)
    expect(second.rows.map((row) => row.id)).toEqual([2, 3])
    source.insert(db, 1000)
    const third = tailer.poll(second.checkpoint)
    expect(third.rows.map((row) => row.id)).toEqual([4, 5])
    expect(third.checkpoint.position).toBe(5)
    expect(third.checkpoint.resetIncarnation).toBe(false)
    const empty = tailer.poll(third.checkpoint)
    expect(empty.rows).toEqual([])
    expect(empty.checkpoint).toEqual(third.checkpoint)
  },
)

test.each(sources)('$kind reopens and re-baselines after atomic database replacement', (source) => {
  const { db, path, tailer } = setup(source)
  source.insert(db)
  source.insert(db)
  const first = tailer.poll()
  const replacement = fixtures.build(source.kind, 'replacement.db')
  source.seed(replacement.db)
  source.insert(replacement.db, 100)
  replacement.db.close()
  // A valid WAL restore flushes the old sidecar before replacing just the main file.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.close()
  renameSync(replacement.path, path)
  expect(incarnationOf(path)).not.toBe(first.checkpoint.incarnation)
  const reset = tailer.poll(first.checkpoint)
  expect(reset.rows.map((row) => row.id)).toEqual([1])
  expect(reset.checkpoint).toMatchObject({ position: 1, resetIncarnation: true })
  expect(reset.checkpoint.incarnation).toBe(incarnationOf(path))
  expect(tailer.poll(reset.checkpoint)).toMatchObject({
    rows: [],
    checkpoint: { resetIncarnation: false },
  })
})

test.each(sources)(
  '$kind resets a persisted checkpoint on the first poll of a new tailer',
  (source) => {
    const { db, tailer } = setup(source)
    source.insert(db)
    expect(tailer.poll({ position: 900, incarnation: 'old-file' })).toMatchObject({
      rows: [{ id: 1 }],
      checkpoint: { position: 1, resetIncarnation: true },
    })
  },
)

test.each(sources)(
  '$kind leaves file mtime, size and incarnation unchanged on polling',
  (source) => {
    const { db, path, tailer } = setup(source)
    source.insert(db)
    db.close()
    const before = statSync(path)
    const incarnation = incarnationOf(path)
    const first = tailer.poll()
    tailer.poll(first.checkpoint)
    tailer.close()
    const after = statSync(path)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)
    expect(incarnationOf(path)).toBe(incarnation)
  },
)

test('tailer opens lazily, keeps its connection, and reports missing without consuming the checkpoint', () => {
  const path = join(fixtures.home, 'kanban.db')
  const read = vi.fn((db: DatabaseSync, afterId: number, limit: number) =>
    tailTaskEvents(db, { afterId, limit }),
  )
  const tailer = createTailer({ path, scope: 'tasks', read, idOf: (row) => row.id })
  tailers.push(tailer)
  expect(read).not.toHaveBeenCalled()
  const missing = tailer.poll({ position: 50, incarnation: 'old-file' })
  expect(missing).toMatchObject({
    rows: [],
    missing: true,
    checkpoint: { position: 50, incarnation: 'old-file' },
  })
  const fixture = fixtures.build('kanban')
  insertEvent(fixture.db)
  const first = tailer.poll(missing.checkpoint)
  expect(first).toMatchObject({ rows: [{ id: 1 }], checkpoint: { resetIncarnation: true } })
  tailer.poll(first.checkpoint)
  expect(read.mock.calls[0]?.[0]).toBe(read.mock.calls[1]?.[0])
  expect(read.mock.calls[0]?.slice(1)).toEqual([0, 500])
  fixture.db.close()
  unlinkSync(path)
  expect(tailer.poll(first.checkpoint)).toMatchObject({ rows: [], missing: true })
  tailer.close()
  expect(() => tailer.poll()).toThrow('closed')
})

test('empty replacement still returns an incarnation reset with position zero', () => {
  const { tailer } = setup(sources[0])
  expect(tailer.poll({ position: 8, incarnation: 'old-file' })).toMatchObject({
    rows: [],
    checkpoint: { position: 0, resetIncarnation: true },
  })
})

test('tailer supports row-array callbacks and finds the maximum ID', () => {
  const { path } = fixtures.build('kanban')
  const tailer = createTailer({
    path,
    scope: 'tasks',
    read: () => [{ id: 4 }, { id: 2 }],
    idOf: (row) => row.id,
  })
  tailers.push(tailer)
  expect(tailer.poll().checkpoint.position).toBe(4)
})
