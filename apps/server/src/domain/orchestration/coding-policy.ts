import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { WorkerPolicy } from '../../runtimes/coding/policy.ts'
import { addStored } from './ops.ts'

// The worker policy each coding worker of a run was approved with (7.7b §3, table `orc_worker_policies`). The stored
// policy holds identities and hashes only; the invocation is rebuilt from it before every launch.

const Row = z.object({
  orchestration_id: z.string(),
  agent_id: z.string(),
  policy_id: z.string(),
  policy: z.string(),
  reach: z.string(),
  reach_beyond_workspace: z.int(),
  acknowledged_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

export interface StoredWorkerPolicy {
  orchestrationId: string
  agentId: string
  policyId: string
  policy: WorkerPolicy
  reach: string
  reachBeyondWorkspace: boolean
  acknowledgedAt: string | null
}

const parse = (row: unknown): StoredWorkerPolicy => {
  const r = Row.parse(row)
  return {
    orchestrationId: r.orchestration_id,
    agentId: r.agent_id,
    policyId: r.policy_id,
    // Written by Score from `WorkerPolicy`; the id is checked against its hash wherever it matters.
    policy: JSON.parse(r.policy) as WorkerPolicy,
    reach: r.reach,
    reachBeyondWorkspace: r.reach_beyond_workspace === 1,
    acknowledgedAt: r.acknowledged_at,
  }
}

export function readWorkerPolicy(
  sqlite: DatabaseSync,
  orchId: string,
  agentId: string,
): StoredWorkerPolicy | undefined {
  const row = sqlite
    .prepare('SELECT * FROM orc_worker_policies WHERE orchestration_id = ? AND agent_id = ?')
    .get(orchId, agentId)
  return row === undefined ? undefined : parse(row)
}

export const workerPoliciesOf = (sqlite: DatabaseSync, orchId: string): StoredWorkerPolicy[] =>
  sqlite
    .prepare('SELECT * FROM orc_worker_policies WHERE orchestration_id = ? ORDER BY agent_id')
    .all(orchId)
    .map(parse)

export function storeWorkerPolicy(
  sqlite: DatabaseSync,
  orchId: string,
  agentId: string,
  value: {
    policyId: string
    policy: WorkerPolicy
    reach: string
    reachBeyondWorkspace: boolean
    acknowledged: boolean
  },
  now: string,
): void {
  const text = JSON.stringify(value.policy)
  // A policy snapshot stays small (identities and hashes): well under the 4 KB the run's reserve charges for it.
  if (Buffer.byteLength(text) > 4096)
    throw new Error('A worker policy snapshot is larger than 4 KB')
  // The snapshot is retained with the run, so it is charged to the run's allowance (design §11).
  addStored(sqlite, orchId, Buffer.byteLength(text) + Buffer.byteLength(value.reach))
  sqlite
    .prepare(
      `INSERT INTO orc_worker_policies (orchestration_id, agent_id, policy_id, policy, reach, reach_beyond_workspace, acknowledged_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(orchestration_id, agent_id) DO UPDATE SET policy_id = excluded.policy_id, policy = excluded.policy,
         reach = excluded.reach, reach_beyond_workspace = excluded.reach_beyond_workspace,
         acknowledged_at = excluded.acknowledged_at, updated_at = excluded.updated_at`,
    )
    .run(
      orchId,
      agentId,
      value.policyId,
      text,
      value.reach,
      value.reachBeyondWorkspace ? 1 : 0,
      value.acknowledged ? now : null,
      now,
      now,
    )
}

/** Why a coding step's stored policy and its approval don't match, or undefined (a DB-only rule, asked by admission). */
export function policyBindingProblem(
  sqlite: DatabaseSync,
  orchId: string,
  stepId: string,
  agentId: string,
  attemptPolicyId: string | null,
): string | undefined {
  const stored = readWorkerPolicy(sqlite, orchId, agentId)
  if (!stored) return 'the agent has no approved settings in this run'
  if (attemptPolicyId !== stored.policyId) return 'the step was admitted under other settings'
  const gate = sqlite
    .prepare(
      "SELECT status, payload FROM orc_gates WHERE orchestration_id = ? AND step_id = ? AND status != 'withdrawn' ORDER BY rowid DESC LIMIT 1",
    )
    .get(orchId, stepId) as { status: string; payload: string } | undefined
  if (!gate) return undefined
  if (gate.status !== 'approved') return 'the step’s approval isn’t current'
  const payload = JSON.parse(gate.payload) as { policyId?: string }
  if (payload.policyId !== stored.policyId) return 'the approval was for other settings'
  return undefined
}
