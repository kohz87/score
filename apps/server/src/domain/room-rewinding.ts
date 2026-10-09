import type { DatabaseSync } from 'node:sqlite'
import { REWIND_COMMAND_TTL_MS, REWIND_HOLD_SKEW_MS } from '@score/contract'

/**
 * Rooms whose agents' Hermes sessions are being rewound right now. A new turn must not start in such a room, or it
 * would run in the session while Hermes undoes turns in it. The set is memory; a rewind command that may still be
 * claimed by the plugin after its request gave up is also written to `rewind_holds` (until the command has provably
 * expired) and restored at startup.
 */
export const rewindingRooms = new Set<string>()

const timers = new Map<string, NodeJS.Timeout>()

/** Persist, before asking Hermes, that this room may be rewound until the command can no longer act. */
export function persistRoomHold(sqlite: DatabaseSync, roomId: string, nowMs: number): number {
  const until = nowMs + REWIND_COMMAND_TTL_MS + REWIND_HOLD_SKEW_MS
  sqlite
    .prepare(
      `INSERT INTO rewind_holds (room_id, until_ms) VALUES (?, ?)
       ON CONFLICT (room_id) DO UPDATE SET until_ms = MAX(until_ms, excluded.until_ms)`,
    )
    .run(roomId, until)
  return until
}

export function clearRoomHold(sqlite: DatabaseSync, roomId: string): void {
  sqlite.prepare('DELETE FROM rewind_holds WHERE room_id = ?').run(roomId)
}

/** Keep the room held in memory until `untilMs`, then release it and its persisted row. */
export function holdRoomUntil(sqlite: DatabaseSync, roomId: string, untilMs: number): void {
  rewindingRooms.add(roomId)
  clearTimeout(timers.get(roomId))
  const timer = setTimeout(
    () => {
      timers.delete(roomId)
      rewindingRooms.delete(roomId)
      try {
        sqlite.prepare('DELETE FROM rewind_holds WHERE room_id = ? AND until_ms <= ?').run(roomId, Date.now())
      } catch {
        // The database is closed (shutdown): the row expires on its own.
      }
    },
    Math.max(0, untilMs - Date.now()),
  )
  timer.unref()
  timers.set(roomId, timer)
}

/** At startup: re-hold the rooms with a command that may still be alive, drop the expired rows. */
export function restoreRoomHolds(sqlite: DatabaseSync, nowMs: number): void {
  sqlite.prepare('DELETE FROM rewind_holds WHERE until_ms <= ?').run(nowMs)
  const rows = sqlite.prepare('SELECT room_id, until_ms FROM rewind_holds').all() as {
    room_id: string
    until_ms: number
  }[]
  for (const row of rows) holdRoomUntil(sqlite, row.room_id, row.until_ms)
}
