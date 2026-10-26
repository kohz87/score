import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { currentSession, retireSession, sessionOwner } from './job-sessions.ts'
import { storeMessage } from './rooms.ts'

// 2.3.1 (decision 129): Hermes' `on_session_delete` hook names the sessions it just deleted. A Score session among them
// moves to its successor at once (Hermes would refuse the id on the next turn), and a deletion the person made is said
// in the room. Hermes' own sweep of empty sessions only moves the id: nothing was said there to lose.
export function hermesDeletedSessions(
  sqlite: DatabaseSync,
  agentId: string,
  sessionIds: string[],
  reason: string,
  now: string,
): DomainEventDraft[] {
  // An archive hides a session; it is not deleted and its id stays usable.
  if (reason !== 'delete' && reason !== 'empty_sweep') return []
  const drafts: DomainEventDraft[] = []
  for (const sessionId of new Set(sessionIds)) {
    const owner = sessionOwner(sqlite, agentId, sessionId)
    // Only the session a room uses now; an older one was already replaced.
    if (!owner || currentSession(sqlite, agentId, sessionId) !== sessionId) continue
    retireSession(sqlite, agentId, sessionId, now)
    if (reason !== 'delete') continue
    try {
      drafts.push(
        ...storeMessage(
          sqlite,
          {
            id: randomUUID(),
            roomId: owner.roomId,
            author: { kind: 'agent', agentId },
            to: [],
            parts: [
              {
                kind: 'text',
                text: 'My conversation for this room was deleted in Hermes, so I’ll start a fresh one with the next message. I won’t remember what was said before.',
              },
            ],
            createdAt: now,
            streaming: false,
            refs: [],
            ...(owner.jobId ? { jobId: owner.jobId } : {}),
          },
          now,
        ),
      )
    } catch {
      // A room that is gone or archived just keeps the successor.
    }
  }
  return drafts
}
