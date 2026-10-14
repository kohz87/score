import type { Ctx } from './ctx.ts'
import { readWorkerPolicy } from './coding-policy.ts'
import { runtimeOfAgent } from './coding-attempts.ts'
import type { OrchRow } from './store.ts'

// The rows of a new attempt (shared by admission and by a workflow node's dispatch renewal, 7.7c §4): the attempt itself in
// `created`, and the reply row its run's text attaches to.

export interface NewAttempt {
  id: string
  kind: 'lead' | 'step'
  stepId: string | null
  n: number
  agentId: string
  incarnation: string
  input: string
  reserved: number
  claim: { from: number; to: number } | null
  /** Created suspended: dispatch skips it and it holds no slot until admission takes it up (a renewal). */
  suspended?: boolean
  /** The policy id the attempt carries; a coding step defaults to the worker's stored policy. */
  policyId?: string | null
}

export function insertAttemptRows(ctx: Ctx, o: OrchRow, a: NewAttempt): void {
  const { sqlite, now } = ctx
  const turnId = `orc-turn-${a.id}`
  sqlite
    .prepare(
      `INSERT INTO orc_attempts (id, orchestration_id, kind, step_id, n, agent_id, agent_incarnation, session_id, turn_id, message_id,
         state, input, reserved_usd, claim_from, claim_to, created_at, updated_at, runtime, policy_id, suspended)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      a.id,
      o.id,
      a.kind,
      a.stepId,
      a.n,
      a.agentId,
      a.incarnation,
      a.id,
      turnId,
      `reply:${turnId}`,
      a.input,
      a.reserved,
      a.claim?.from ?? null,
      a.claim?.to ?? null,
      now,
      now,
      a.kind === 'step' ? runtimeOfAgent(sqlite, a.agentId) : 'hermes',
      a.kind !== 'step'
        ? null
        : a.policyId !== undefined
          ? a.policyId
          : (readWorkerPolicy(sqlite, o.id, a.agentId)?.policyId ?? null),
      a.suspended ? 1 : 0,
    )
  // The reply row the run's text attaches to. Never queued by the room dispatcher (orchestration_attempt_id).
  sqlite
    .prepare(
      `INSERT INTO message_runs (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, created_at, orchestration_attempt_id)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `reply:${turnId}`,
      o.room_id,
      a.agentId,
      o.brief_id,
      turnId,
      o.brief_id,
      a.kind === 'lead' ? `Lead turn ${a.n}` : `Step ${a.stepId}`,
      JSON.stringify(
        o.lead_agent_id === null ? o.allowed_agents : [o.lead_agent_id, ...o.allowed_agents],
      ),
      now,
      a.id,
    )
}
