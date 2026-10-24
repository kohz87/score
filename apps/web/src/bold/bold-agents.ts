import type { AgentSummary } from '@score/contract'

const nameTokens: Record<string, string> = {
  '#6B4EFF': 'var(--agent-violet-name)',
  '#19C39A': 'var(--agent-jade-name)',
  '#FFB61E': 'var(--agent-saffron-name)',
  '#FF6B8A': 'var(--agent-coral-name)',
}

/** The word the dock and the one-to-one list use for an agent's state (the prototype's "free", "needs you", …). */
export function agentStateLabel(agent: AgentSummary): string {
  if (agent.status === 'waiting') return 'needs you'
  if (agent.status === 'idle') return 'free'
  if (agent.status === 'up-next') return 'up next'
  return agent.status
}

/** The README's light name tint on dark, Score's dark tint in the light look; other colours keep the page ink. */
export function agentNameColor(agent: AgentSummary): string {
  return nameTokens[agent.style.color.toUpperCase()] ?? 'var(--ink)'
}

/** The contract has an agent's status, not a run percentage yet: the frame shows a working arc at the prototype's 65%. */
export function dockProgress(agent: AgentSummary): number {
  return agent.status === 'working' ? 65 : 0
}
