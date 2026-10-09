import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { HttpError } from '../errors.ts'
import { rewindingRooms } from './room-rewinding.ts'
import { continuationFor, markSummarySent } from './outside-sessions.ts'
import { failMessageRun, MessageRunSchema, roomRunInput } from './message-runs.ts'

/** How long a turn waits for an outside session to go quiet before it fails with `session_busy`. */
export const SESSION_BUSY_WAIT_MS = 10 * 60_000

/** A refusal may carry the sentence the room should show (a coding CLI that is missing or untested). */
function refusalNotice(error: HttpError): string | undefined {
  const notice = (error.details as { notice?: unknown } | undefined)?.notice
  return typeof notice === 'string' ? notice : undefined
}

/** Durable queue; only one active turn per (room, agent). */
export class RoutingDispatcher {
  private flight: Promise<void> | undefined
  private closed = false
  /** When each turn first found its continued outside session busy. */
  private readonly busySince = new Map<string, number>()
  private readonly unsubscribe: () => void
  private readonly timer: NodeJS.Timeout

  constructor(
    private readonly db: ScoreDb,
    private readonly ingest: Ingest,
    private readonly port: HermesPort,
    private readonly onError: (error: unknown) => void,
  ) {
    this.unsubscribe = ingest.onCommitted((events) => {
      if (events.some((event) => event.type === 'message.completed'))
        return this.dispatch().catch(onError)
    })
    this.timer = setInterval(() => {
      void this.dispatch().catch(onError)
    }, 10000)
    this.timer.unref()
  }

  dispatch(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.flight) return this.flight
    this.flight = this.pump().finally(() => {
      this.flight = undefined
    })
    return this.flight
  }

  private async pump(): Promise<void> {
    const attempted = new Set<string>()
    let failure: unknown
    while (!this.closed) {
      const pending = this.db.read((sqlite) =>
        z.array(MessageRunSchema).parse(
          sqlite
            .prepare(
              `
        SELECT q.* FROM message_runs q WHERE q.state = 'pending' AND NOT EXISTS (
          SELECT 1 FROM agent_lifecycle l WHERE l.agent_id = q.agent_id AND l.state != 'ready'
        ) AND NOT EXISTS (
          SELECT 1 FROM team_state WHERE paused_at IS NOT NULL
        ) AND NOT EXISTS (
          SELECT 1 FROM agent_pauses held WHERE held.agent_id = q.agent_id
        ) AND NOT EXISTS (
          SELECT 1 FROM briefs paused WHERE paused.id = q.chain_id AND paused.paused_at IS NOT NULL
        ) AND NOT EXISTS (
          SELECT 1 FROM message_runs active WHERE active.room_id = q.room_id AND active.agent_id = q.agent_id AND active.state = 'active'
        ) AND NOT EXISTS (
          SELECT 1 FROM message_runs earlier WHERE earlier.room_id = q.room_id AND earlier.agent_id = q.agent_id
            AND earlier.state = 'pending' AND (earlier.created_at, earlier.rowid) < (q.created_at, q.rowid)
            AND NOT EXISTS (
              SELECT 1 FROM briefs held WHERE held.id = earlier.chain_id AND held.paused_at IS NOT NULL
            )
        ) ORDER BY q.created_at, q.rowid`,
            )
            .all(),
        ),
      )
      const job = pending.find(
        (row) => !attempted.has(row.turn_id) && !rewindingRooms.has(row.room_id),
      )
      if (!job) break
      attempted.add(job.turn_id)
      try {
        // Freeze the admission context once: a crash retry must match the adapter's intent payload.
        await this.ingest.submit({
          source: 'routing',
          identity: `input:${job.turn_id}`,
          apply: ({ sqlite }) => {
            if (job.admission_input !== null) return []
            let input = roomRunInput(sqlite, job.room_id, job.input, job.parent_message_id)
            // An imported room whose Hermes session could not be continued: the first turn carries a recap (PLAN 5.26).
            const continuation = continuationFor(sqlite, job.room_id, job.agent_id)
            if (continuation.summaryTurn && continuation.summary) {
              input = `${input}\n\n${continuation.summary}`
              markSummarySent(sqlite, job.room_id, job.agent_id)
            }
            sqlite
              .prepare(
                'UPDATE message_runs SET admission_input = ? WHERE turn_id = ? AND admission_input IS NULL',
              )
              .run(input, job.turn_id)
            return []
          },
        })
        const frozen = this.db.read((sqlite) =>
          MessageRunSchema.parse(
            sqlite.prepare('SELECT * FROM message_runs WHERE turn_id = ?').get(job.turn_id),
          ),
        )
        // Cancelled (the message was edited) while its context was being frozen: do not start it.
        if (frozen.state !== 'pending') continue
        // A room that continues an outside session shares it with another surface: check again before every turn.
        const continued = this.db.read((sqlite) =>
          continuationFor(sqlite, job.room_id, job.agent_id),
        ).sessionId
        if (continued) {
          const outside = await this.port.readOutsideSession(job.agent_id, continued)
          if (outside?.session.busy) {
            const since = this.busySince.get(job.turn_id) ?? Date.now()
            this.busySince.set(job.turn_id, since)
            if (Date.now() - since < SESSION_BUSY_WAIT_MS) continue
            this.busySince.delete(job.turn_id)
            await this.ingest.submit({
              source: 'routing',
              identity: `failed:${job.turn_id}`,
              apply: ({ sqlite, now }) =>
                failMessageRun(
                  sqlite,
                  job.turn_id,
                  'session_busy',
                  now,
                  'The original session stayed active on its other platform, so this turn was not started (session_busy). Send it again when that session has been quiet for a few minutes.',
                ),
            })
            continue
          }
          this.busySince.delete(job.turn_id)
        }
        const images = job.hop === 0 ? this.imageIds(job.parent_message_id) : []
        await this.port.startRun({
          agentId: job.agent_id,
          input: frozen.admission_input!,
          turnId: job.turn_id,
          sessionId:
            this.db.read((sqlite) => continuationFor(sqlite, job.room_id, job.agent_id))
              .sessionId ?? `score-${job.room_id}-${job.agent_id}`,
          ...(job.model ? { model: job.model } : {}),
          ...(frozen.provider ? { provider: frozen.provider } : {}),
          ...(images.length ? { images } : {}),
        })
      } catch (error) {
        // A permanent refusal (unknown or unserved agent, invalid input) would otherwise be retried every 10 s
        // forever: fail the turn once and tell the room. Transient errors keep retrying.
        if (
          error instanceof HttpError &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 409, 429].includes(error.status)
        ) {
          await this.ingest.submit({
            source: 'routing',
            identity: `failed:${job.turn_id}`,
            apply: ({ sqlite, now }) =>
              failMessageRun(sqlite, job.turn_id, error.code, now, refusalNotice(error)),
          })
          continue
        }
        failure ??= error
        this.onError(error)
      }
    }
    if (failure) throw failure
  }

  // Only the person's own message carries images; hand-offs between agents send none.
  private imageIds(messageId: string): string[] {
    const row = this.db.read((sqlite) =>
      sqlite.prepare('SELECT parts FROM messages WHERE id = ?').get(messageId),
    )
    const parts = z
      .object({ parts: z.string() })
      .transform((value) => JSON.parse(value.parts) as unknown)
      .pipe(z.array(z.object({ kind: z.string(), mediaId: z.string().optional() }).loose()))
      .safeParse(row)
    if (!parts.success) return []
    return parts.data.flatMap((part) =>
      part.kind === 'image' && part.mediaId ? [part.mediaId] : [],
    )
  }

  async close(): Promise<void> {
    this.closed = true
    this.unsubscribe()
    clearInterval(this.timer)
    await this.flight?.catch(() => undefined)
  }
}
