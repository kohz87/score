import type { AgentSummary } from '@score/contract'
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
