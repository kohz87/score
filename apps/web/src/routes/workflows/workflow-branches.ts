import { WORKFLOW_LIMITS, type BranchCondition } from '@score/contract'
import { nextRuleId } from './workflow-model-ids.ts'
import type { Draft } from './workflow-model-types.ts'
import { updateNode } from './workflow-nodes.ts'

export function addRule(draft: Draft, branchId: string): Draft {
  const node = draft.nodes.find((n) => n.id === branchId)
  if (node?.kind !== 'branch' || node.rules.length >= WORKFLOW_LIMITS.maxBranchRules) return draft
  const rule = { id: nextRuleId(node), when: { kind: 'verdict', is: 'passed' } as BranchCondition }
  return updateNode(draft, branchId, { rules: [...node.rules, rule] })
}

export function updateRule(
  draft: Draft,
  branchId: string,
  ruleId: string,
  when: BranchCondition,
): Draft {
  const node = draft.nodes.find((n) => n.id === branchId)
  if (node?.kind !== 'branch') return draft
  return updateNode(draft, branchId, {
    rules: node.rules.map((rule) => (rule.id === ruleId ? { ...rule, when } : rule)),
  })
}

/** Removing a rule removes the connections that left through it. */
export function removeRule(draft: Draft, branchId: string, ruleId: string): Draft {
  const node = draft.nodes.find((n) => n.id === branchId)
  if (node?.kind !== 'branch') return draft
  const next = updateNode(draft, branchId, {
    rules: node.rules.filter((rule) => rule.id !== ruleId),
  })
  return { ...next, edges: next.edges.filter((e) => !(e.from === branchId && e.port === ruleId)) }
}
