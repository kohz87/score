import { randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { JobSourceSchema, TRIGGER_LIMITS, type JobSource, type QueueItem } from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { activeJob, createJob } from '../exchanges/store.ts'
import { reserveMessageRun } from '../message-runs.ts'
import { roomChanged, storeMessage } from '../rooms.ts'

// 3.28.0 (decision 164): a group chat runs one job at a time. Trigger calls that arrive while its job runs wait here
// (Next up), oldest first, and start when the job ends; the person can skip one.

const QueueRowSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  trigger_id: z.string(),
  webhook_id: z.string(),
  title: z.string(),
  source: z.string(),
  opening: z.string(),
  created_at: z.string(),
})
type QueueRow = z.infer<typeof QueueRowSchema>

/** What a trigger call starts: its job's room, title, source and the lead's (already redacted) opening message. */
export interface TriggerCall {
  team: string
  triggerId: string
  webhookId: string
  title: string
  source: JobSource
  opening: string
}

/** Puts a call in its team room's queue (Next up): it starts when the room's running job ends. */
function enqueueCall(sqlite: DatabaseSync, call: TriggerCall, now: string): string {
  const id = `q_${randomBytes(12).toString('hex')}`
  sqlite
    .prepare(
      `INSERT INTO room_queue (id, room_id, trigger_id, webhook_id, title, source, opening, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      call.team,
      call.triggerId,
      call.webhookId,
      call.title,
      JSON.stringify(call.source),
      call.opening,
      now,
    )
  return id
}

/** Starts a trigger call's job in its team room and gives the lead its turn (the caller has checked the room is free). */
export function startTriggerJob(
  sqlite: DatabaseSync,
  call: TriggerCall,
  now: string,
): { jobId: string; drafts: DomainEventDraft[] } {
  const { team } = call
  const made = createJob(sqlite, team, call.title, now, {
    spendCapUsd: TRIGGER_LIMITS.jobSpendCapUsd,
  })
  sqlite
    .prepare('UPDATE jobs SET source = ? WHERE id = ?')
    .run(JSON.stringify(call.source), made.job.id)
  const messageId = randomUUID()
  const lead = (
    sqlite.prepare('SELECT lead_agent_id FROM rooms WHERE id = ?').get(team) as {
      lead_agent_id: string | null
    }
  ).lead_agent_id
  const drafts = [
    ...made.drafts,
    ...storeMessage(
      sqlite,
      {
        id: messageId,
        roomId: team,
        author: { kind: 'you' },
        to: lead ? [lead] : [],
        parts: [
          { kind: 'text', text: call.opening },
          ...(lead
            ? []
            : [
                {
                  kind: 'notice' as const,
                  code: 'no_lead' as const,
                  text: 'The team has no lead yet, so nobody was asked to start.',
                },
              ]),
        ],
        createdAt: now,
        streaming: false,
        refs: [],
        jobId: made.job.id,
      },
      now,
    ),
  ]
  if (lead)
    reserveMessageRun(
      sqlite,
      {
        parentMessageId: messageId,
        roomId: team,
        agentId: lead,
        chainId: messageId,
        hop: 0,
        input: call.opening,
        agents: [lead],
      },
      now,
    )
  sqlite
    .prepare(
      'INSERT OR REPLACE INTO trigger_calls (trigger_id, webhook_id, received_at, job_id) VALUES (?, ?, ?, ?)',
    )
    .run(call.triggerId, call.webhookId, now, made.job.id)
  return { jobId: made.job.id, drafts }
}

/**
 * A verified call: it starts now when its room is free and nothing older waits; otherwise it goes to the back of the
 * queue, and a free room starts its oldest waiting call (which may be this one).
 */
export function takeCall(
  sqlite: DatabaseSync,
  call: TriggerCall,
  now: string,
):
  | { started: true; jobId: string; drafts: DomainEventDraft[] }
  | { started: false; queueId: string; drafts: DomainEventDraft[] } {
  if (!activeJob(sqlite, call.team) && !hasQueued(sqlite, call.team)) {
    const made = startTriggerJob(sqlite, call, now)
    return { started: true, ...made }
  }
  const queueId = enqueueCall(sqlite, call, now)
  const next = startQueued(sqlite, call.team, now)
  const job = sqlite
    .prepare('SELECT job_id FROM trigger_calls WHERE trigger_id = ? AND webhook_id = ?')
    .get(call.triggerId, call.webhookId) as { job_id: string | null } | undefined
  if (next.started && job?.job_id) return { started: true, jobId: job.job_id, drafts: next.drafts }
  return {
    started: false,
    queueId,
    drafts: [...next.drafts, ...roomChanged(sqlite, call.team, now)],
  }
}

function rows(sqlite: DatabaseSync, roomId: string): QueueRow[] {
  return sqlite
    .prepare('SELECT * FROM room_queue WHERE room_id = ? ORDER BY rowid')
    .all(roomId)
    .map((row) => QueueRowSchema.parse(row))
}

export function listQueue(sqlite: DatabaseSync, roomId: string): QueueItem[] {
  return rows(sqlite, roomId).map((row) => {
    const source = JobSourceSchema.parse(JSON.parse(row.source))
    return {
      id: row.id,
      roomId: row.room_id,
      title: row.title,
      source: {
        app: source.app,
        ref: source.ref,
        title: source.title,
        triggerId: source.triggerId,
      },
      createdAt: row.created_at,
    }
  })
}

/** Skip: the call is dropped and starts nothing. Its webhook id stays answered, so a retry doesn't queue it again. */
export function skipQueued(
  sqlite: DatabaseSync,
  roomId: string,
  itemId: string,
  now: string,
): DomainEventDraft[] {
  const row = sqlite
    .prepare('SELECT trigger_id, webhook_id FROM room_queue WHERE id = ? AND room_id = ?')
    .get(itemId, roomId) as { trigger_id: string; webhook_id: string } | undefined
  if (!row) throw new HttpError(404, 'not_found', 'That call is no longer waiting.')
  sqlite.prepare('DELETE FROM room_queue WHERE id = ?').run(itemId)
  sqlite
    .prepare(
      'INSERT OR REPLACE INTO trigger_calls (trigger_id, webhook_id, received_at, job_id) VALUES (?, ?, ?, NULL)',
    )
    .run(row.trigger_id, row.webhook_id, now)
  return roomChanged(sqlite, roomId, now)
}

/** Whether a room has calls waiting (cheap: read before taking a write transaction). */
export function hasQueued(sqlite: DatabaseSync, roomId: string): boolean {
  return Boolean(sqlite.prepare('SELECT 1 FROM room_queue WHERE room_id = ? LIMIT 1').get(roomId))
}

/**
 * Starts the oldest waiting call when the room has no job running. A call whose trigger was deleted meanwhile is
 * dropped. Returns `started` so the caller dispatches the lead's turn.
 */
export function startQueued(
  sqlite: DatabaseSync,
  roomId: string,
  now: string,
): { started: boolean; drafts: DomainEventDraft[] } {
  if (activeJob(sqlite, roomId)) return { started: false, drafts: [] }
  const waiting = rows(sqlite, roomId)
  if (waiting.length === 0) return { started: false, drafts: [] }
  for (const row of waiting) {
    sqlite.prepare('DELETE FROM room_queue WHERE id = ?').run(row.id)
    const live = sqlite
      .prepare('SELECT 1 FROM triggers WHERE id = ? AND deleted_at IS NULL')
      .get(row.trigger_id)
    if (!live) continue
    const started = startTriggerJob(
      sqlite,
      {
        team: roomId,
        triggerId: row.trigger_id,
        webhookId: row.webhook_id,
        title: row.title,
        source: JobSourceSchema.parse(JSON.parse(row.source)),
        opening: row.opening,
      },
      now,
    )
    return { started: true, drafts: [...started.drafts, ...roomChanged(sqlite, roomId, now)] }
  }
  // Every waiting call's trigger was gone: the queue emptied, so the room's Next up changed.
  return { started: false, drafts: roomChanged(sqlite, roomId, now) }
}
