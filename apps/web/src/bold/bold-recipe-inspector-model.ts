import type { AgentSummary, BranchCondition } from '@score/contract'

const AGENT_KINDS = new Set(['hermes', 'claude-code', 'codex'])

export type ConditionKey =
  | 'verdict:passed'
  | 'verdict:changes_requested'
  | 'outcome:succeeded'
  | 'outcome:failed'
  | 'output_contains'

export function conditionKey(when: BranchCondition): ConditionKey {
  if (when.kind === 'verdict') return `verdict:${when.is}`
  if (when.kind === 'outcome') return `outcome:${when.is}`
  return 'output_contains'
}

export function conditionFrom(key: ConditionKey, current: BranchCondition): BranchCondition {
  if (key === 'verdict:passed') return { kind: 'verdict', is: 'passed' }
  if (key === 'verdict:changes_requested') return { kind: 'verdict', is: 'changes_requested' }
  if (key === 'outcome:succeeded') return { kind: 'outcome', is: 'succeeded' }
  if (key === 'outcome:failed') return { kind: 'outcome', is: 'failed' }
  return { kind: 'output_contains', text: current.kind === 'output_contains' ? current.text : '' }
}

export function refusalsFor(runtime: AgentSummary['runtime']): boolean {
  return runtime !== undefined && runtime !== null && !AGENT_KINDS.has(runtime)
}
