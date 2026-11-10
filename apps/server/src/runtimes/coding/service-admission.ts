import { randomUUID } from 'node:crypto'
import { assertAgentAdmits } from '../../domain/agent-lifecycle.ts'
import { attachRunMessage, isCancelledTurn } from '../../domain/message-runs.ts'
import { turnWitnessed } from '../../domain/orchestration/coding-checkpoint.ts'
import type { OrchestrationOwner } from '../../domain/orchestration/owner.ts'
import { HttpError } from '../../errors.ts'
import { runDraft } from '../../hermes/index.ts'
import { checkRoot } from '../../workspace/policy.ts'
import { driverFor } from './drivers.ts'
import { CodingRuntimeExecution } from './service-execution.ts'
import {
  IntentPayload,
  IntentRow,
  KIND,
  TERMINAL_NOTE,
  UNRESOLVED_NOTE,
  oneLine,
  type ActiveRun,
} from './service-types.ts'
import { cliSessionFor, getCodingAgent } from './store.ts'
import { newTranslation } from './translate.ts'

export class CodingRuntimeAdmission extends CodingRuntimeExecution {
  /**
   * Admits a room turn for a coding agent. Mirrors the Hermes path: a durable intent first, then the run row and the
   * room's streaming reply, then the process. Only after the run is admitted does anything spawn.
   */
  startRun(req: {
    agentId: string
    input: string
    turnId: string
    sessionId?: string
    model?: string
    owner?: 'orchestration' | OrchestrationOwner
    jobId?: string
    effort?: string
  }): Promise<{ runId: string }> {
    // Admission is serialised per turn (S4-C01): a second call for the same turn waits for the first and then finds its
    // accepted intent, so both return the one persisted run id and only one execution is scheduled.
    const previous = this.admissions.get(req.turnId) ?? Promise.resolve()
    const mine = previous.then(() => this.admit(req))
    const tail = mine.then(
      () => undefined,
      () => undefined,
    )
    this.admissions.set(req.turnId, tail)
    void tail.then(() => {
      if (this.admissions.get(req.turnId) === tail) this.admissions.delete(req.turnId)
    })
    return mine
  }

  protected async admit(req: {
    agentId: string
    input: string
    turnId: string
    sessionId?: string
    model?: string
    owner?: 'orchestration' | OrchestrationOwner
    jobId?: string
    effort?: string
  }): Promise<{ runId: string }> {
    const { db, ingest } = this.deps
    const owner = typeof req.owner === 'object' ? req.owner : undefined
    this.assertOpen()
    const agent = getCodingAgent(db.sqlite, req.agentId)
    if (!agent) throw new HttpError(404, 'not_found', 'Couldn’t find that coding agent.')
    assertAgentAdmits(db.sqlite, agent.id)
    if (this.hasUnresolvedGroup(agent.id))
      throw new HttpError(422, 'agent_still_stopping', UNRESOLVED_NOTE, {
        notice: UNRESOLVED_NOTE,
        agentId: agent.id,
        cause: 'hold',
      })
    // A frozen home admits nothing, whichever engine would launch (decision 71).
    const frozen = this.deps.frozen?.() ?? null
    if (frozen)
      throw new HttpError(422, 'coding_paused', frozen, { notice: frozen, cause: 'frozen' })
    // Supervised units pause on a fence (an unreadable journal, orphan units): the person reviews it first (design §7).
    const paused = this.deps.unit?.block() ?? null
    if (paused)
      throw new HttpError(422, 'coding_paused', paused, { notice: paused, cause: 'fenced' })
    const driver = driverFor(agent.runtime)
    const existing = db.sqlite
      .prepare('SELECT * FROM command_intents WHERE idempotency_key = ?')
      .get(req.turnId)
    if (existing !== undefined) {
      const intent = IntentRow.parse(existing)
      if (intent.state === 'accepted' && intent.result) return { runId: intent.result }
    }
    // A launch of this turn may already have executed (the journal says so, e.g. after a database restore): never run it
    // again (7.7a code review #4).
    if (turnWitnessed(db.sqlite, req.turnId))
      throw new HttpError(
        409,
        'turn_witnessed',
        'This message may already have run before Score restarted, so it won’t run again. Send it again if you want a new run.',
      )
    // Refuse before anything is stored: a missing or untested CLI is the person's to fix, not a retry loop.
    const refusal = await this.cliRefusal(agent, driver, false)
    if (refusal)
      throw new HttpError(422, refusal.code, refusal.message, {
        notice: refusal.notice,
        cause: refusal.cause,
      })
    // The room's shared workspace (3.20.0) unless an orchestration worker, which keeps the folder its policy froze.
    const folder = req.owner ? agent.workspace : this.workspaceFor(agent, this.roomOf(req.turnId))
    const checked = await checkRoot(folder, this.deps.policy)
    if (!checked.ok)
      throw new HttpError(422, 'workspace_unavailable', checked.reason, {
        notice: `The workspace is unavailable: ${checked.reason}`,
        cause: 'workspace_unavailable',
      })
    // An owned turn runs only as a supervised unit (7.7b §1): a host that lost its units refuses it before admission.
    if (owner && !this.deps.unit?.usable())
      throw new HttpError(
        422,
        'coding_paused',
        'Coding agents can take orchestration steps only where Score runs them as supervised system services.',
        { notice: 'This host cannot supervise coding runs right now.', cause: 'needs_units' },
      )

    // 1. Durable intent (idempotent per turn).
    const payload = IntentPayload.parse({
      agentId: agent.id,
      input: req.input,
      sessionId: req.sessionId ?? null,
      model: req.model ?? agent.model,
    })
    let intentId: string
    if (existing !== undefined) {
      const intent = IntentRow.parse(existing)
      if (intent.state === 'failed')
        throw new HttpError(422, 'admission_refused', 'This message was refused earlier.')
      intentId = intent.id
    } else {
      intentId = randomUUID()
      const now = new Date().toISOString()
      db.sqlite
        .prepare(
          `INSERT INTO command_intents (id, kind, idempotency_key, payload, state, owner, orchestration_attempt_id, generation, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        )
        .run(
          intentId,
          KIND,
          req.turnId,
          JSON.stringify(payload),
          owner ? 'orchestration' : null,
          owner?.attemptId ?? null,
          owner?.generation ?? null,
          now,
          now,
        )
    }
    // 2. Admission: the run row and the room's streaming reply, in one observation.
    const known = db.sqlite
      .prepare('SELECT id FROM runs WHERE score_turn_id = ?')
      .get(req.turnId) as { id: string } | undefined
    const proposed = known?.id ?? `cr_${randomUUID()}`
    const job = this.jobOf(req.turnId)
    // An owned turn never resumes a CLI session: one launch per generation, a fresh context per step (7.7b §5).
    const resumed = job && !owner ? cliSessionFor(db.sqlite, job, agent.id) : null
    await ingest.submit({
      source: `coding:${agent.id}`,
      identity: `admitted:${intentId}`,
      apply({ sqlite, now }) {
        const inserted = sqlite
          .prepare(
            `INSERT INTO runs (id, profile, origin, score_turn_id, session_id, status, model, started_at, updated_at, runtime)
             VALUES (?, ?, 'score', ?, ?, 'queued', ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
          )
          .run(proposed, agent.id, req.turnId, resumed, payload.model, now, now, agent.runtime)
        return [
          ...(inserted.changes ? [runDraft(sqlite, proposed)] : []),
          ...attachRunMessage(sqlite, req.turnId, proposed, now),
        ]
      },
    })
    // The id that was persisted, never the proposed one: an earlier admission of this turn (a replayed identity applies
    // nothing) may have stored a different run.
    const persisted = db.sqlite
      .prepare('SELECT id FROM runs WHERE score_turn_id = ?')
      .get(req.turnId) as { id: string } | undefined
    if (!persisted) throw new Error('admission stored no run for this turn')
    const runId = persisted.id
    db.sqlite
      .prepare(
        "UPDATE command_intents SET state = 'accepted', result = ?, updated_at = ? WHERE id = ?",
      )
      .run(runId, new Date().toISOString(), intentId)
    // The reply was cancelled while it was being admitted: nothing to run.
    if (isCancelledTurn(db.sqlite, req.turnId)) {
      await this.finish(newTranslation(runId, agent.id, job), {
        status: 'cancelled',
        costKind: driver.runtime === 'claude-code' ? 'estimated' : 'unknown',
      })
      return { runId }
    }
    // Closed while the turn was being admitted: end it visibly, never spawn it.
    if (this.closed) {
      await this.finish(newTranslation(runId, agent.id, job), {
        status: 'interrupted',
        error: TERMINAL_NOTE.interrupted,
        costKind: 'unknown',
      })
      throw new HttpError(
        503,
        'shutting_down',
        'Score is shutting down. Try again once it has restarted.',
        { cause: 'restart' },
      )
    }
    let settleEnded = (): void => undefined
    const entry: ActiveRun = {
      agentId: agent.id,
      runId,
      turnId: req.turnId,
      ...(owner ? { owner } : {}),
      ...(req.jobId ? { jobId: req.jobId } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
      ended: new Promise<boolean>((resolve) => {
        settleEnded = () => resolve(!entry.unproven)
      }),
      settle: () => settleEnded(),
    }
    this.active.set(runId, entry)
    // One turn per coding agent at a time: later turns wait their turn (the run shows as queued).
    const previous = this.queues.get(agent.id) ?? Promise.resolve()
    const mine = previous.then(() =>
      this.execute(entry, agent, payload.input, job, payload.model).catch((error: unknown) =>
        // Preparing the turn failed (settings folder, spawn setup…): end the run and the reply, never leave it queued.
        this.finish(newTranslation(runId, agent.id, job), {
          status: 'failed',
          error: `Could not prepare the run: ${oneLine(error instanceof Error ? error.message : String(error), 200)}`,
          costKind: 'unknown',
        }).then(() => this.deps.onError?.(error)),
      ),
    )
    const tail = mine
      .catch((error: unknown) => this.deps.onError?.(error))
      .finally(() => entry.settle())
    this.queues.set(agent.id, tail)
    void tail.finally(() => {
      // A result still waiting to be saved keeps the entry (S3-004): it goes once the delivery has committed.
      const delivery = this.deliveries.get(runId)
      if (delivery) void delivery.finally(() => this.active.delete(runId))
      else this.active.delete(runId)
      if (this.queues.get(agent.id) === tail) this.queues.delete(agent.id)
    })
    return { runId }
  }

  /** The runtime a run belongs to (`runs.runtime`), or undefined when Score has no row for it. Controls route by it. */
  runtimeOfRun(runId: string): string | undefined {
    return (
      this.deps.db.sqlite.prepare('SELECT runtime FROM runs WHERE id = ?').get(runId) as
        { runtime: string } | undefined
    )?.runtime
  }

  /**
   * Whether any run of this agent is unresolved: queued or running, ended but not proven ended, a launch that isn't
   * settled, or a held process group. Such an agent can't be removed (7.7b §2, `409 agent_busy`).
   */
  hasUnresolvedRuns(agentId: string): boolean {
    const { sqlite } = this.deps.db
    return (
      sqlite
        .prepare(
          `SELECT 1 FROM runs WHERE profile = ? AND runtime != 'hermes' AND
             (status IN ('queued','running','waiting_for_approval') OR terminal_source = 'unconfirmed') LIMIT 1`,
        )
        .get(agentId) !== undefined ||
      sqlite
        .prepare(
          "SELECT 1 FROM coding_launches WHERE agent_id = ? AND phase != 'settled' AND waiver = 0 LIMIT 1",
        )
        .get(agentId) !== undefined ||
      this.hasUnresolvedGroup(agentId)
    )
  }
}
