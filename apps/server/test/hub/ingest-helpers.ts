import { StreamEventSchema, type StreamEvent } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { createIngest, type DomainEventDraft, type Observation } from '../../src/hub/index.ts'

const migrationDir = fileURLToPath(new URL('../../migrations/', import.meta.url))
export const now = '2026-10-06T12:00:00.000Z'
let dir = ''
let state: IngestTestState
const connections: DatabaseSync[] = []

export interface IngestTestState {
  db: ScoreDb
  ingest: ReturnType<typeof createIngest>
  expectListenerErrors: boolean
  listenerLog: ReturnType<typeof vi.spyOn>
}

export function setupIngestTest(testState: IngestTestState) {
  state = testState
  beforeEach(() => {
    state.expectListenerErrors = false
    state.listenerLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    dir = mkdtempSync(join(tmpdir(), 'score-ingest-'))
    state.db = openDatabase(join(dir, 'score.db'))
    migrate(state.db, migrationDir)
    state.db.sqlite.exec(
      'CREATE TABLE test_runs (id TEXT PRIMARY KEY, state TEXT, updated_at TEXT) STRICT',
    )
    state.ingest = createIngest(state.db, { clock: () => Date.parse(now) })
  })
  afterEach(async () => {
    await state.ingest.drain()
    await state.ingest.flushListeners()
    await state.ingest.close()
    if (!state.expectListenerErrors) expect(state.listenerLog).not.toHaveBeenCalled()
    for (const connection of connections.splice(0)) connection.close()
    state.db.close()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })
}

export function draft(id: string): DomainEventDraft {
  return { type: 'message.completed', data: { messageId: id, roomId: 'room' } }
}

export function observation(identity: string, overrides: Partial<Observation> = {}): Observation {
  return {
    source: 'score',
    identity,
    checkpoint: {
      scope: 'runs',
      position:
        Number(identity) ||
        ({ one: 1, two: 2, three: 3, four: 4, broken: 10 } as Record<string, number>)[identity] ||
        0,
      incarnation: 'incarnation-1',
    },
    apply({ sqlite, now }) {
      sqlite
        .prepare('INSERT INTO test_runs (id, state, updated_at) VALUES (?, ?, ?)')
        .run(identity, 'queued', now)
      return [draft(identity)]
    },
    ...overrides,
  }
}

export function rows(table: string) {
  return state.db.read((sqlite) => sqlite.prepare(`SELECT * FROM ${table}`).all())
}

export function persistedEvents(): StreamEvent[] {
  return state.db.read((sqlite) =>
    sqlite
      .prepare('SELECT seq, ts, type, data FROM events ORDER BY seq')
      .all()
      .map((row) =>
        StreamEventSchema.parse({
          ...row,
          data: JSON.parse(String(row.data)),
        }),
      ),
  )
}

export function secondConnection(): DatabaseSync {
  const connection = new DatabaseSync(join(dir, 'score.db'))
  connections.push(connection)
  return connection
}
