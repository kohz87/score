import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach } from 'vitest'
import {
  closeReadOnly,
  createTailer,
  openReadOnly,
  tailMessages,
  tailTaskEvents,
  type ReaderBatch,
} from '../../../src/hermes/live/index.ts'
import {
  createFixtureHome,
  insertEvent,
  insertMessage,
  insertSession,
  insertTask,
} from '../../fixtures/hermes/sqlite-fixture.ts'

export let fixtures: ReturnType<typeof createFixtureHome>
const readers: DatabaseSync[] = []
export const tailers: { close(): void }[] = []

export function installSqliteHooks() {
  beforeEach(() => {
    fixtures = createFixtureHome()
  })

  afterEach(() => {
    for (const tailer of tailers.splice(0)) tailer.close()
    for (const reader of readers.splice(0)) {
      if (reader.isOpen) closeReadOnly(reader)
    }
    fixtures.close()
  })
}

export function open(path: string) {
  const reader = openReadOnly(path)
  readers.push(reader)
  return reader
}

export const sources = [
  { kind: 'kanban', seed: insertTask, insert: insertEvent, read: tailTaskEvents },
  { kind: 'state', seed: insertSession, insert: insertMessage, read: tailMessages },
] as const

export function setup(source: (typeof sources)[number], limit = 500) {
  const fixture = fixtures.build(source.kind)
  source.seed(fixture.db)
  const tailer = createTailer({
    path: fixture.path,
    scope: source.kind === 'kanban' ? 'tasks' : 'builder',
    limit,
    read: (db, afterId, limit): ReaderBatch<{ id: number }> => source.read(db, { afterId, limit }),
    idOf: (row) => row.id,
  })
  tailers.push(tailer)
  return { ...fixture, tailer }
}
