import type { WorkflowNodeKind } from '@score/contract'
import type { BranchNode, Draft } from './workflow-model-types.ts'

const ID_PREFIX: Record<WorkflowNodeKind, string> = {
  agent: 'step',
  gate: 'gate',
  branch: 'branch',
  join: 'join',
  end: 'end',
}

/** Node ids are `[a-z][a-z0-9_-]{0,31}`; this picks the first free `<kind><n>`. */
export function nextNodeId(draft: Draft, kind: WorkflowNodeKind): string {
  const taken = new Set(draft.nodes.map((node) => node.id))
  for (let n = 1; ; n++) {
    const id = `${ID_PREFIX[kind]}${n}`
    if (!taken.has(id)) return id
  }
}

export function nextEdgeId(draft: Pick<Draft, 'edges'>): string {
  const taken = new Set(draft.edges.map((edge) => edge.id))
  for (let n = 1; ; n++) {
    const id = `e${n}`
    if (!taken.has(id)) return id
  }
}

export function nextRuleId(node: BranchNode): string {
  const taken = new Set(node.rules.map((rule) => rule.id))
  for (let n = 1; ; n++) {
    const id = `rule${n}`
    if (!taken.has(id) && id !== 'default') return id
  }
}
