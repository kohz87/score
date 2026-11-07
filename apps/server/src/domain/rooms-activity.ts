import type { DatabaseSync } from 'node:sqlite'
import { AgentIdSchema } from '@score/contract'
import { z } from 'zod'
import { actionable, ApprovalRowSchema } from './approval-store.ts'
import type { RoomRow } from './rooms-rows.ts'

let compatibility: (() => readonly string[]) | null = null
/** The features the compatibility check switched off, as the approvals API sees them (set once by the app). */
export function setRoomCompatibility(disabled: (() => readonly string[]) | null): void {
  compatibility = disabled
}

export const disabledFeatures = (): readonly string[] => compatibility?.() ?? []

/**
 * What makes members busy, read once for many rooms (PLAN 10.11; the room stage's rules in `stage-mood.ts`): replies
 * still streaming per room, and the pending actionable approvals with the rooms each belongs to (its card is there, or
 * its run was started there; none means a gateway approval that belongs everywhere its agent is a member).
 */
export type ActivityIndex = {
  streaming: Map<string, Set<string>>
  approvals: { agent: string; rooms: string[] }[]
}

const StreamingRowSchema = z.object({ room_id: z.string(), author_agent_id: AgentIdSchema })

/** Two indexed queries, however many rooms; the optional scope narrows them to one room and its members. */
export function activityIndex(
  sqlite: DatabaseSync,
  now: string,
  scope?: { roomId: string; agents: string[] },
): ActivityIndex {
  const streaming = new Map<string, Set<string>>()
  const rows = z.array(StreamingRowSchema).parse(
    scope
      ? sqlite
          .prepare(
            `SELECT DISTINCT room_id, author_agent_id FROM messages
             WHERE streaming = 1 AND deleted_at IS NULL AND author_kind = 'agent' AND room_id = ?`,
          )
          .all(scope.roomId)
      : sqlite
          .prepare(
            `SELECT DISTINCT room_id, author_agent_id FROM messages
             WHERE streaming = 1 AND deleted_at IS NULL AND author_kind = 'agent'`,
          )
          .all(),
  )
  for (const row of rows) {
    const set = streaming.get(row.room_id) ?? new Set<string>()
    set.add(row.author_agent_id)
    streaming.set(row.room_id, set)
  }
  const agentFilter = scope ? ` AND a.profile IN (${scope.agents.map(() => '?').join(', ')})` : ''
  const pending = sqlite
    .prepare(
      `SELECT a.*, m.room_id AS card_room, r.room_id AS run_room FROM approvals a
       LEFT JOIN messages m ON m.id = 'approval:' || a.id AND m.deleted_at IS NULL
       LEFT JOIN message_runs r ON r.run_id = a.run_id
       WHERE a.visible = 1 AND a.stage = 'human' AND a.phase = 'human_pending' AND a.status = 'pending'${agentFilter}`,
    )
    .all(...(scope?.agents ?? []))
  const disabled = disabledFeatures()
  const approvals: ActivityIndex['approvals'] = []
  for (const value of pending) {
    const approval = ApprovalRowSchema.parse(value)
    if (!actionable(sqlite, approval, { now: Date.parse(now), disabled })) continue
    const rooms = z
      .object({ card_room: z.string().nullable(), run_room: z.string().nullable() })
      .parse(value)
    approvals.push({
      agent: approval.profile,
      rooms: [...new Set([rooms.card_room, rooms.run_room].filter((id) => id !== null))],
    })
  }
  return { streaming, approvals }
}

export const membersOf = (row: Pick<RoomRow, 'members' | 'lead_agent_id'>): string[] => {
  const members = z.array(AgentIdSchema).parse(JSON.parse(row.members))
  return row.lead_agent_id && !members.includes(row.lead_agent_id)
    ? [...members, row.lead_agent_id]
    : members
}

/** Members busy in a room: sorted by id. */
export function busyAgents(
  row: Pick<RoomRow, 'id' | 'members' | 'lead_agent_id'>,
  index: ActivityIndex,
): string[] {
  const here = new Set(membersOf(row))
  const busy = new Set([...(index.streaming.get(row.id) ?? [])].filter((id) => here.has(id)))
  for (const approval of index.approvals)
    if (
      here.has(approval.agent) &&
      (approval.rooms.length === 0 || approval.rooms.includes(row.id))
    )
      busy.add(approval.agent)
  return [...busy].sort()
}
