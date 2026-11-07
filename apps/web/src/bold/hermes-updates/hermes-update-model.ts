import type { AgentSummary } from '@score/contract'
import { canTalkTo } from '../bold-agents.ts'

export const NONE = '__none'
const GB = 1024 ** 3

export function gb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`
}

/** The Hermes agents (not the coding agents) that can answer a test message. */
export function hermesAgents(agents: AgentSummary[]): AgentSummary[] {
  return agents.filter(
    (agent) => (!agent.runtime || agent.runtime === 'hermes') && canTalkTo(agent),
  )
}

export const STEP_LABEL = {
  wait: 'Waiting for agents to finish',
  update: 'Backing up and updating Hermes',
  check: 'Checking the new version',
} as const

export const MARK = { pending: '', running: '…', done: '✓', failed: '!', skipped: '–' } as const
