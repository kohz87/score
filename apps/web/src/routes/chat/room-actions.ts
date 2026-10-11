import {
  RoomDeletePlanSchema,
  SessionContextSchema,
  SessionContextSnapshotSchema,
  CompactAcceptedSchema,
  type CompactFailureReason,
  type RoomDeletePlan,
  type SessionCompacted,
  type SessionContext,
} from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { defineStreamQuery } from '../../data/resync.ts'

/** The agent's session for a room, as the server names it (an imported room's continued session stands behind it). */
export const roomSessionId = (roomId: string, agentId: string) => `score-${roomId}-${agentId}`

const sessionPath = (agentId: string, sessionId: string) =>
  `agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`

export async function fetchDeletePlan(roomId: string): Promise<RoomDeletePlan> {
  return RoomDeletePlanSchema.parse(
    await apiFetch(`rooms/${encodeURIComponent(roomId)}/delete-plan`),
  )
}

export async function deleteRoom(roomId: string, confirm: string, key: string): Promise<void> {
  await apiFetch(`rooms/${encodeURIComponent(roomId)}`, {
    method: 'DELETE',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify({ confirm }),
  })
}

/** Asks Hermes to compact; the answer is the stream's `session.compacted` (it takes a model call). */
export async function startCompaction(
  agentId: string,
  sessionId: string,
  keepRecent: number,
): Promise<string> {
  return CompactAcceptedSchema.parse(
    await apiFetch(`${sessionPath(agentId, sessionId)}/compact`, {
      method: 'POST',
      headers: { 'Idempotency-Key': newId() },
      body: JSON.stringify({ keepRecent }),
    }),
  ).commandId
}

export interface SessionContextState {
  context: SessionContext
  /** The latest answer to a compact request seen on the stream since this page opened. */
  compaction: SessionCompacted | null
}

export async function fetchSessionContext(
  agentId: string,
  sessionId: string,
): Promise<SessionContext> {
  const snapshot = SessionContextSnapshotSchema.parse(
    await apiFetch(`${sessionPath(agentId, sessionId)}/context`),
  )
  return SessionContextSchema.parse(snapshot)
}

export function sessionContextQuery(agentId: string, sessionId: string) {
  // A snapshot refetch (after a compaction, after a reply) must not forget the answer it was refetched for.
  let latest: SessionCompacted | null = null
  return defineStreamQuery<SessionContextState>({
    key: ['chat', 'session-context', agentId, sessionId],
    async fetch() {
      const { asOfSeq, ...context } = SessionContextSnapshotSchema.parse(
        await apiFetch(`${sessionPath(agentId, sessionId)}/context`),
      )
      return { asOfSeq, data: { context, compaction: latest } }
    },
    types: ['session.compacted'],
    reduce(data, event) {
      if (
        event.type !== 'session.compacted' ||
        event.data.agentId !== agentId ||
        event.data.sessionId !== sessionId
      )
        return data
      latest = event.data
      return { ...data, compaction: event.data }
    },
  })
}

export const COMPACT_FAILURE_TEXT: Record<CompactFailureReason, string> = {
  bridge_unavailable:
    'Score’s bridge is not running in this agent’s gateway, so Hermes could not be asked.',
  no_answer: 'Hermes did not answer in time. It may or may not have compacted the session.',
  session_busy: 'Hermes is using this session right now. Try again in a moment.',
  lock_held: 'Hermes is already compacting this session. Try again in a moment.',
  no_session: 'Hermes has no session for this agent in this room yet.',
  compact_failed: 'Hermes could not compact this session.',
}

// Same rule as the API (PLAN 5.26): "#launch" or "launch", optionally followed by #tag words.
const ROOM_NAME = /^#?[a-z0-9][a-z0-9-]{0,63}( #[a-z0-9][a-z0-9-]{0,31}){0,8}$/

/** What is wrong with a typed room name, or null when the API will take it. */
export function roomNameProblem(text: string): string | null {
  const name = text.trim()
  if (!name) return 'Give the room a name.'
  if (!ROOM_NAME.test(name))
    return 'Use lowercase letters, numbers and dashes, like “launch” or “launch #q4”.'
  return null
}
