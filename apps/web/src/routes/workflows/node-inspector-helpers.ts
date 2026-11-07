import type { AgentSummary, BranchCondition } from '@score/contract'

export function conditionKey(when: BranchCondition): string {
  return when.kind === 'verdict'
    ? `verdict:${when.is}`
    : when.kind === 'outcome'
      ? `outcome:${when.is}`
      : 'output_contains'
}

export function conditionFrom(key: string, current: BranchCondition): BranchCondition {
  if (key === 'verdict:passed') return { kind: 'verdict', is: 'passed' }
  if (key === 'verdict:changes_requested') return { kind: 'verdict', is: 'changes_requested' }
  if (key === 'outcome:succeeded') return { kind: 'outcome', is: 'succeeded' }
  if (key === 'outcome:failed') return { kind: 'outcome', is: 'failed' }
  return { kind: 'output_contains', text: current.kind === 'output_contains' ? current.text : '' }
}

/** Why an agent can't take a step, or null when it can: Hermes, Claude Code and Codex agents can. */
export function refusalFor(runtime: AgentSummary['runtime']): string | null {
  return !runtime || runtime === 'hermes' || runtime === 'claude-code' || runtime === 'codex'
    ? null
    : 'can’t take workflow steps'
}
