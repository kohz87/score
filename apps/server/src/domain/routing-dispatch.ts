import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { HttpError } from '../errors.ts'
import { requestSummary, shouldAutoSummarise } from './room-summaries.ts'
import { compactingKey, compactingSessions, rewindingRooms } from './room-rewinding.ts'
import { continuationFor, markSummarySent } from './outside-sessions.ts'
import { failMessageRun, MessageRunSchema, roomRunInput } from './message-runs.ts'
import { sessionFor, usesRoomSession } from './job-sessions.ts'
import { hashXtc, mintXtc, withXtc } from './exchanges/capability.ts'
import { jobRunInput } from './exchanges/context.ts'

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
      const completed = events.flatMap((event) =>
        event.type === 'message.completed' ? [event.data.messageId] : [],
      )
      if (completed.length)
        return this.summarise(new Set(completed))
          .then(() => this.dispatch())
          .catch(onError)
    })
    this.timer = setInterval(() => {
      void this.dispatch().catch(onError)
    }, 10000)
    this.timer.unref()
  }

  /**
   * Opt-in summaries (PLAN 7.4a), one per job (11.1b): a job past its room's threshold gets a summary run through the
   * room's lead agent. Takes the ids of the messages that just completed.
   */
  private async summarise(messageIds: Set<string>): Promise<void> {
    const jobs = new Map<string, string>()
    this.db.read((sqlite) => {
      for (const messageId of messageIds) {
        const row = sqlite
          .prepare('SELECT room_id, job_id FROM messages WHERE id = ?')
          .get(messageId) as { room_id: string; job_id: string | null } | undefined
        if (row?.job_id) jobs.set(row.job_id, row.room_id)
      }
    })
    for (const [jobId, roomId] of jobs) {
      if (this.closed || !this.db.read((sqlite) => shouldAutoSummarise(sqlite, roomId, jobId)))
        continue
      await this.ingest.submit({
        source: 'routing',
        identity: randomUUID(),
        apply: ({ sqlite, now }) => {
          // Re-checked inside the transaction; a refusal (paused, nothing to cover) just means "not now".
          if (shouldAutoSummarise(sqlite, roomId, jobId)) requestSummary(sqlite, roomId, now, jobId)
          return []
        },
      })
    }
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
      // A frozen home sends no chat reply (decision 72); the replies stay queued until the history is reset.
      if (this.port.executionHold?.() != null) break
      const pending = this.db.read((sqlite) =>
        z.array(MessageRunSchema).parse(
          sqlite
            .prepare(
              `
        SELECT q.* FROM message_runs q WHERE q.state = 'pending' AND q.orchestration_attempt_id IS NULL AND NOT EXISTS (
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
        (row) =>
          !attempted.has(row.turn_id) &&
          !rewindingRooms.has(row.room_id) &&
          !compactingSessions.has(compactingKey(row.room_id, row.agent_id)),
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
            // A room that routes with exchanges gives the turn its job's context and how to act (PLAN 11.1b). A
            // plan-first turn only proposes a plan, so it gets the room's context and no actions.
            let input = exchangesRoom(sqlite, job.room_id) && !job.plan_first
              ? jobRunInput(sqlite, job, { coding: codingAgent(sqlite, job.agent_id) })
              : roomRunInput(sqlite, job.room_id, job.input, job.parent_message_id, job.job_id)
            // An imported room whose Hermes session could not be continued: the first turn carries a recap (PLAN 5.26).
            // Only the job that runs in the room's own session continues it.
            const continuation = continuationFor(sqlite, job.room_id, job.agent_id)
            if (
              continuation.summaryTurn &&
              continuation.summary &&
              usesRoomSession(sqlite, job.job_id)
            ) {
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
        // A Hermes agent's turn in an exchanges room acts through the bridge tools with a capability of its own: a
        // fresh one per start, only its hash stored, filled into the payload in memory (brief §4.2).
        const capability = this.db.read(
          (sqlite) =>
            exchangesRoom(sqlite, job.room_id) && !job.plan_first && !codingAgent(sqlite, job.agent_id),
        )
          ? mintXtc()
          : null
        if (capability)
          this.db.tx((sqlite) =>
            sqlite
              .prepare(
                "UPDATE message_runs SET xtc_hash = ? WHERE turn_id = ? AND state = 'pending'",
              )
              .run(hashXtc(capability), job.turn_id),
          )
        await this.port.startRun({
          agentId: job.agent_id,
          input: frozen.admission_input!,
          turnId: job.turn_id,
          sessionId: this.db.read((sqlite) =>
            sessionFor(sqlite, {
              roomId: job.room_id,
              jobId: job.job_id ?? null,
              agentId: job.agent_id,
            }),
          ),
          ...(job.model ? { model: job.model } : {}),
          ...(frozen.provider ? { provider: frozen.provider } : {}),
          ...(images.length ? { images } : {}),
          ...(capability ? { render: (stored: string) => withXtc(stored, capability) } : {}),
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

function exchangesRoom(sqlite: DatabaseSync, roomId: string): boolean {
  const row = sqlite.prepare('SELECT routing FROM rooms WHERE id = ?').get(roomId) as
    { routing: string } | undefined
  return row?.routing === 'exchanges'
}

function codingAgent(sqlite: DatabaseSync, agentId: string): boolean {
  return Boolean(
    sqlite.prepare('SELECT 1 FROM coding_agents WHERE id = ? AND removed_at IS NULL').get(agentId),
  )
}
