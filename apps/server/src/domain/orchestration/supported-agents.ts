import type { AgentSummary, WorkerReadiness } from '@score/contract'
import type { WorkerPolicy } from '../../runtimes/coding/policy.ts'
import { HttpError } from '../../errors.ts'

/**
 * Orchestrations and workflows run Hermes agents only until PLAN 7.7 adds coding agents as workers: the executor still
 * starts every step through Hermes, so a coding agent's step would fail there. This is the one place that says so;
 * lifting the limit means deleting the call sites' use of it.
 */
export function assertHermesOnly(
  ids: readonly string[],
  agents: readonly Pick<AgentSummary, 'id' | 'runtime'>[],
): void {
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const coding = [...new Set(ids)].filter((id) => {
    const runtime = byId.get(id)?.runtime
    return runtime !== undefined && runtime !== 'hermes'
  })
  if (coding.length === 0) return
  throw new HttpError(
    422,
    'unsupported_agent',
    `Coding agents can’t take orchestration or workflow steps yet (${coding.join(', ')}). Choose Hermes agents instead.`,
  )
}

/** What the guard needs to know about coding agents; supplied by the composition root, absent where there is no coding runtime. */
export interface CodingWorkerFacts {
  /** The host supervises coding runs as systemd units and the capability check passes right now. */
  unitHost(): boolean
  agent(id: string): { runtime: string; permission: string } | undefined
  /** Preflight's view of a coding worker: readiness and the policy to approve (7.7b §3). */
  report(agentId: string): Promise<WorkerReport>
  /** The policy id of what would run now for a stored policy, every identity read again (sync; never throws on a mismatch). */
  checkPolicy(agentId: string, policy: WorkerPolicy): PolicyCheck
}

export interface WorkerReport {
  readiness: WorkerReadiness
  detail: string | null
  policy: WorkerPolicy | null
  policyId: string | null
  reach: string | null
  reachBeyondWorkspace: boolean
}
export type PolicyCheck =
  | { ok: true; id: string }
  | { ok: false; cause: 'agent_changed' | 'reach_unverifiable'; detail: string }

/** Permissions a coding worker may never run with: one rule for create, remap and the release check (7.7c F1 #1). */
export const isForbiddenPermission = (permission: string): boolean => permission === 'full'

export const forbiddenPermissionError = (agentIds: readonly string[]): HttpError =>
  new HttpError(
    422,
    'unsupported_agent',
    `${agentIds.join(', ')} has full access. Orchestration steps need a coding agent that is read-only or limited to its workspace.`,
  )

/** Coding runtimes that can take orchestration steps (7.7b §1). Antigravity may leave scheduled work behind its run. */
export const WORKER_RUNTIMES: readonly string[] = ['claude-code', 'codex']

/**
 * The orchestration guard (7.7b §1): the lead is always a Hermes agent; step agents may also be Claude Code or Codex
 * workers with a `read-only` or `workspace-write` permission, on a host that runs coding turns as units. Workflows keep
 * `assertHermesOnly` until 7.7c.
 */
export function assertOrchestrationWorkers(
  leadId: string,
  workerIds: readonly string[],
  agents: readonly Pick<AgentSummary, 'id' | 'runtime'>[],
  facts: CodingWorkerFacts | undefined,
): void {
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const runtimeOf = (id: string) => byId.get(id)?.runtime ?? 'hermes'
  if (runtimeOf(leadId) !== 'hermes')
    throw new HttpError(
      422,
      'unsupported_agent',
      `${leadId} is a coding agent. The lead of an orchestration has to be a Hermes agent.`,
    )
  const coding = [...new Set(workerIds)].filter((id) => runtimeOf(id) !== 'hermes')
  if (coding.length === 0) return
  const unsupported = coding.filter(
    (id) => !WORKER_RUNTIMES.includes(runtimeOf(id)) || facts?.agent(id) === undefined,
  )
  if (unsupported.length > 0)
    throw new HttpError(
      422,
      'unsupported_agent',
      `${unsupported.join(', ')} can’t take orchestration steps. Choose Hermes, Claude Code or Codex agents.`,
    )
  const full = coding.filter((id) => isForbiddenPermission(facts!.agent(id)!.permission))
  if (full.length > 0) throw forbiddenPermissionError(full)
  if (!facts!.unitHost())
    throw new HttpError(
      422,
      'coding_workers_need_units',
      'Coding agents can take orchestration steps only where Score runs them as supervised system services, and this computer isn’t set up for that right now. Settings › Coding shows what is missing.',
    )
}
