import type { WatchFrame } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { FRAME_COLUMNS, FrameRowSchema, toFrame } from './watch-store.ts'
import type { WatchPage } from './watch-types.ts'

export function readWatch(
  sqlite: DatabaseSync,
  agentId: string,
  { from, limit }: { from?: number | undefined; limit: number },
): WatchPage {
  const rows = z.array(FrameRowSchema).parse(
    from === undefined
      ? sqlite
          .prepare(
            `SELECT ${FRAME_COLUMNS} FROM
               (SELECT * FROM watch_frames WHERE agent_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq`,
          )
          .all(agentId, limit)
      : sqlite
          .prepare(
            `SELECT ${FRAME_COLUMNS} FROM watch_frames
             WHERE agent_id = ? AND seq >= ? ORDER BY seq LIMIT ?`,
          )
          .all(agentId, from, limit),
  )
  const markers = z
    .array(
      z.object({
        seq: z.int().positive(),
        at: z.iso.datetime(),
        kind: z.enum(['command', 'file', 'browser', 'asked']),
      }),
    )
    .parse(
      sqlite
        .prepare(
          `SELECT seq, at, marker_kind AS kind FROM watch_frames
           WHERE agent_id = ? AND marker_kind IS NOT NULL ORDER BY seq DESC LIMIT 2000`,
        )
        .all(agentId),
    )
    .reverse()
  // A question for the human lands on the nearest earlier frame, so scrubbing to it shows what was on screen.
  const asked = z.array(z.object({ at: z.iso.datetime() })).parse(
    sqlite
      .prepare(
        `SELECT created_at AS at FROM approvals WHERE profile = ? AND visible = 1
           ORDER BY created_at DESC LIMIT 200`,
      )
      .all(agentId),
  )
  for (const { at } of asked) {
    const near = sqlite
      .prepare(
        'SELECT seq FROM watch_frames WHERE agent_id = ? AND at <= ? ORDER BY seq DESC LIMIT 1',
      )
      .get(agentId, at)
    if (near) markers.push({ seq: z.object({ seq: z.int() }).parse(near).seq, at, kind: 'asked' })
  }
  markers.sort((x, y) => x.seq - y.seq || x.at.localeCompare(y.at))
  return { frames: rows.map(toFrame), markers }
}

/** One stored frame as Watch shows it, or null when it is gone. */
export function readFrame(sqlite: DatabaseSync, agentId: string, seq: number): WatchFrame | null {
  const row = sqlite
    .prepare(`SELECT ${FRAME_COLUMNS} FROM watch_frames WHERE agent_id = ? AND seq = ?`)
    .get(agentId, seq)
  const parsed = FrameRowSchema.safeParse(row)
  return parsed.success ? toFrame(parsed.data) : null
}

export function isLive(sqlite: DatabaseSync, agentId: string): boolean {
  return (
    sqlite
      .prepare(
        "SELECT 1 FROM runs WHERE profile = ? AND status IN ('queued','running','waiting_for_approval') LIMIT 1",
      )
      .get(agentId) !== undefined
  )
}
