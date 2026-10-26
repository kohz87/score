import type { AgentSummary } from '@score/contract'
import type { FaceMood } from '../components/agent-face.ts'

const nameTokens: Record<string, string> = {
  '#6B4EFF': 'var(--agent-violet-name)',
  '#19C39A': 'var(--agent-jade-name)',
  '#FFB61E': 'var(--agent-saffron-name)',
  '#FF6B8A': 'var(--agent-coral-name)',
}

/** The one display rule for an agent: its Score name, else its immutable profile id. */
export function agentDisplayName(agent: Pick<AgentSummary, 'id' | 'name'>): string {
  return agent.name || agent.id
}

/** The word the dock, agent page and one-to-one list use for an agent's state (the prototype's "free", "needs you", …). */
/** On the team: everyone but a removed agent (whose history stays readable elsewhere). The dock and the Team page. */
export function onTeam(agent: Pick<AgentSummary, 'lifecycle'>): boolean {
  return agent.lifecycle?.state !== 'removed'
}

/** Can take a one-to-one now: ready (not setting up, needing attention, leaving or removed). */
export function canTalkTo(agent: Pick<AgentSummary, 'lifecycle'>): boolean {
  return !agent.lifecycle || agent.lifecycle.state === 'ready'
}

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

/**
 * The contract has an agent's status, not a run percentage yet (PLAN 11.2 adds one). Until then no ring draws an arc:
 * a made-up share would look like real progress.
 */
export function dockProgress(): number | null {
  return null
}

/**
 * The eyes' mood for an agent's status (decision 127): working -> working, waiting -> needs you, paused / offline ->
 * resting (half-lidded, slow blink, no looking about), the rest idle. Thinking and done are momentary and are passed
 * where a call site knows them.
 */
export function agentMood(agent: Pick<AgentSummary, 'status'>): FaceMood {
  switch (agent.status) {
    case 'working':
      return 'working'
    case 'waiting':
      return 'needs'
    case 'paused':
    case 'offline':
      return 'resting'
    default:
      return 'idle'
  }
}
