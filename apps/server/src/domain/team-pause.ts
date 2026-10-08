import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

/** The Now headline starts with this while the team is paused; the web app reads the flag from it. */
export const PAUSED_HEADLINE = 'Everyone is paused.'

const StateRow = z.object({ paused_at: z.iso.datetime().nullable() })

export function teamPausedAt(sqlite: DatabaseSync): string | null {
  const row = sqlite.prepare('SELECT paused_at FROM team_state WHERE id = 1').get()
  return row === undefined ? null : StateRow.parse(row).paused_at
}

export function setTeamPaused(sqlite: DatabaseSync, now: string | null): void {
  sqlite.prepare('UPDATE team_state SET paused_at = ? WHERE id = 1').run(now)
}

export function countRunningRuns(sqlite: DatabaseSync): number {
  const row = z
    .object({ n: z.int() })
    .parse(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM runs WHERE status IN ('running', 'waiting_for_approval')`,
        )
        .get(),
    )
  return row.n
}
