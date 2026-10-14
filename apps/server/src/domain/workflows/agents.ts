import type { AgentSummary, ValidationIssue, ValidationResult } from '@score/contract'
import { WORKER_RUNTIMES, type CodingWorkerFacts } from '../orchestration/supported-agents.ts'

// 7.7c §1: the runtime half of workflow validation. The graph rules (`validateDefinition`) look at the definition alone;
// these look at the team and the host. They are never part of a definition or its hash: whether a CLI is installed or a
// host runs coding turns as units can change without the definition changing, and a stored version stays valid data.

type TeamMember = Pick<AgentSummary, 'id' | 'runtime'>

const LABELS: Record<string, string> = {
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

/** The agent nodes whose agent is a coding agent of the team (in node order, once per node). */
export function codingNodesOf(
  definition: { nodes: readonly { id: string; kind: string; agentId?: string }[] },
  team: readonly TeamMember[],
): { nodeId: string; agentId: string; runtime: string }[] {
  const byId = new Map(team.map((agent) => [agent.id, agent]))
  return definition.nodes.flatMap((node) => {
    if (node.kind !== 'agent' || node.agentId === undefined) return []
    const runtime = byId.get(node.agentId)?.runtime
    return runtime === undefined || runtime === 'hermes'
      ? []
      : [{ nodeId: node.id, agentId: node.agentId, runtime }]
  })
}

/** The ids of the agent nodes that are coding steps. */
export const codingNodeIdsOf = (
  definition: Parameters<typeof codingNodesOf>[0],
  team: readonly TeamMember[],
): Set<string> => new Set(codingNodesOf(definition, team).map((node) => node.nodeId))

/** The distinct coding agents of a definition, in first-use order. */
export const codingAgentsOf = (
  definition: Parameters<typeof codingNodesOf>[0],
  team: readonly TeamMember[],
): string[] => [...new Set(codingNodesOf(definition, team).map((node) => node.agentId))]

/**
 * Structured issues for the agents of a workflow (never throws). Claude Code and Codex may be the agent of a step node
 * when their permission is read-only or workspace-write and the host runs coding turns as supervised units; anything
 * else that isn't a Hermes agent is refused. Graph `gate` nodes have no agent.
 */
export function validateWorkflowAgents(
  definition: Parameters<typeof codingNodesOf>[0],
  team: readonly TeamMember[],
  facts: CodingWorkerFacts | undefined,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const issue = (code: ValidationIssue['code'], nodeId: string, message: string): void => {
    issues.push({ code, severity: 'error', nodeId, edgeId: null, field: 'agentId', message })
  }
  for (const node of codingNodesOf(definition, team)) {
    const label = LABELS[node.runtime] ?? node.runtime
    const agent = facts?.agent(node.agentId)
    if (!WORKER_RUNTIMES.includes(node.runtime) || agent === undefined) {
      issue(
        'coding_agent_unsupported',
        node.nodeId,
        `${node.agentId} is a ${label} agent, which can’t take workflow steps. Choose a Hermes, Claude Code or Codex agent.`,
      )
      continue
    }
    if (agent.permission === 'full') {
      issue(
        'coding_permission_full',
        node.nodeId,
        `${node.agentId} has full access. Workflow steps need a coding agent that is read-only or limited to its workspace.`,
      )
      continue
    }
    if (!facts!.unitHost())
      issue(
        'coding_workers_need_units',
        node.nodeId,
        'Coding agents can take workflow steps only where Score runs them as supervised system services, and this computer isn’t set up for that right now. Settings › Coding shows what is missing.',
      )
  }
  return issues
}

/** The graph result with the agent issues added; `ok` is false when either has an error. */
export function withAgentIssues(
  result: ValidationResult,
  issues: readonly ValidationIssue[],
): ValidationResult {
  if (issues.length === 0) return result
  const all = [...result.issues, ...issues]
  return { ...result, ok: !all.some((entry) => entry.severity === 'error'), issues: all }
}
