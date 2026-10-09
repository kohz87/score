import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { z } from 'zod'
import { migrate, openDatabase, type ScoreDb } from '../../../src/db/index.ts'
import { createIngest, type Ingest } from '../../../src/hub/ingest.ts'
import {
  KanbanAttemptsCoordinator,
  type CoordinatorOptions,
} from '../../../src/hermes/live/kanban-attempts/coordinator.ts'
import { AttemptRowSchema, type AttemptRow } from '../../../src/domain/kanban-attempts.ts'
import { createFixtureHome } from '../hermes/sqlite-fixture.ts'
import { FakeBoard } from './fake-board.ts'

export const MIGRATIONS = fileURLToPath(new URL('../../../migrations/', import.meta.url))

export interface Harness {
  home: string
  board: FakeBoard
  score: ScoreDb
  ingest: Ingest
  clock: { ms: number }
  coordinators: KanbanAttemptsCoordinator[]
  make(options?: Partial<CoordinatorOptions>): KanbanAttemptsCoordinator
  /** Poll with the clock advanced past the sweep and full-pass intervals each time. */
  poll(coordinator: KanbanAttemptsCoordinator, times?: number): Promise<void>
  attempts(): AttemptRow[]
  attempt(attemptId: number, historyId?: string): AttemptRow
  histories(): { id: string; state: string; reason: string | null; event_alloc_mark: number; attempt_alloc_mark: number; event_cursor: number; baseline_done: number; baseline_cursor: number; fullpass_cursor: number; file_identity: string | null }[]
  pages(): { capture_id: string; kind: string; outcome: string; history_id: string }[]
  close(): Promise<void>
}

export function createHarness(): Harness {
  const fixture = createFixtureHome()
  const board = new FakeBoard(join(fixture.home, 'kanban.db'))
  const score = openDatabase(join(fixture.home, 'score.db'))
  migrate(score, MIGRATIONS)
  // Score's clock follows the board's: observation times are comparable with the epoch seconds Hermes wrote.
  const clock = { ms: (board.clock + 1) * 1000 }
  const ingest = createIngest(score, { clock: () => clock.ms })
  const coordinators: KanbanAttemptsCoordinator[] = []
  const harness: Harness = {
    home: fixture.home,
    board,
    score,
    ingest,
    clock,
    coordinators,
    make(options = {}) {
      const coordinator = new KanbanAttemptsCoordinator({
        db: score,
        sink: ingest,
        path: board.path,
        clock: () => clock.ms,
        ...options,
      })
      coordinators.push(coordinator)
      return coordinator
    },
    async poll(coordinator, times = 1) {
      for (let index = 0; index < times; index++) {
        clock.ms += 11_000
        await coordinator.poll()
      }
    },
    attempts() {
      return z
        .array(AttemptRowSchema)
        .parse(score.sqlite.prepare('SELECT * FROM kanban_attempts ORDER BY history_id, attempt_id').all())
    },
    attempt(attemptId, historyId) {
      const rows = harness
        .attempts()
        .filter((row) => row.attempt_id === attemptId && (historyId === undefined || row.history_id === historyId))
      if (rows.length !== 1) throw new Error(`expected one attempt ${attemptId}, found ${rows.length}`)
      return rows[0]!
    },
    histories() {
      return score.sqlite.prepare('SELECT * FROM kanban_histories ORDER BY opened_at, rowid').all() as never
    },
    pages() {
      return score.sqlite.prepare('SELECT * FROM kanban_pages ORDER BY rowid').all() as never
    },
    async close() {
      for (const coordinator of coordinators) await coordinator.close()
      await ingest.close()
      board.close()
      score.close()
      fixture.close()
    },
  }
  return harness
}
