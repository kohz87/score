import { WORKFLOW_LIMITS, type WorkflowNode, type WorkflowNodeKind } from '@score/contract'
import { escapeRegExp } from './workflow-model-helpers.ts'
import { nextEdgeId, nextNodeId } from './workflow-model-ids.ts'
import { portsOf, type Draft } from './workflow-model-types.ts'

export function blankNode(draft: Draft, kind: WorkflowNodeKind, agentId = ''): WorkflowNode {
  const id = nextNodeId(draft, kind)
  switch (kind) {
    case 'agent':
      return {
        id,
        kind,
        label: 'New step',
        agentId,
        instruction: '',
        retries: 0,
        onFailure: 'fail_run',
      }
    case 'gate':
      return { id, kind, label: 'Check with me', question: '', onReject: 'stop_run' }
    case 'branch':
      return {
        id,
        kind,
        label: 'Branch',
        subject: '',
        rules: [{ id: 'rule1', when: { kind: 'verdict', is: 'passed' } }],
      }
    case 'join':
      return { id, kind, label: 'Join', mode: 'all' }
    case 'end':
      return { id, kind, label: 'Done' }
  }
}

export function starterDraft(agentId: string): Draft {
  const step: WorkflowNode = {
    id: 'step1',
    kind: 'agent',
    label: 'First step',
    agentId,
    instruction: '',
    retries: 0,
    onFailure: 'fail_run',
  }
  return {
    name: 'Untitled workflow',
    inputs: [],
    nodes: [step, { id: 'end1', kind: 'end', label: 'Done' }],
    edges: [{ id: 'e1', from: 'step1', port: 'ok', to: 'end1' }],
  }
}

export function addNode(
  draft: Draft,
  kind: WorkflowNodeKind,
  agentId = '',
): { draft: Draft; id: string } | { error: string } {
  if (draft.nodes.length >= WORKFLOW_LIMITS.maxNodes)
    return { error: `A workflow can have at most ${WORKFLOW_LIMITS.maxNodes} steps.` }
  const node = blankNode(draft, kind, agentId)
  return { draft: { ...draft, nodes: [...draft.nodes, node] }, id: node.id }
}

/** Moves, drops or renames one node's saved position; an emptied layout disappears. */
function relayout(draft: Draft, from: string, to: string | null): Draft['layout'] {
  const nodes = draft.layout?.nodes
  if (!nodes || !Object.hasOwn(nodes, from)) return draft.layout
  const { [from]: at, ...rest } = nodes
  const next = to === null ? rest : { ...rest, [to]: at! }
  return Object.keys(next).length === 0 ? undefined : { nodes: next }
}

function setLayout(draft: Draft, layout: Draft['layout']): Draft {
  const { layout: _old, ...rest } = draft
  void _old
  return layout ? { ...rest, layout } : rest
}

export function removeNode(draft: Draft, id: string): Draft {
  return setLayout(
    {
      ...draft,
      nodes: draft.nodes.filter((node) => node.id !== id),
      edges: draft.edges.filter((edge) => edge.from !== id && edge.to !== id),
    },
    relayout(draft, id, null),
  )
}

/**
 * Deletes a step. A step with exactly one way in and one way out (the way on, not a failure or rejection route) joins the
 * step before it to the step after it, on the same ports, so the recipe stays in one piece; any other shape just loses
 * the step and its connections, as removeNode does.
 */
export function removeNodeJoining(draft: Draft, id: string): { draft: Draft; note: string | null } {
  const node = draft.nodes.find((item) => item.id === id)
  const into = draft.edges.filter((edge) => edge.to === id)
  const out = draft.edges.filter((edge) => edge.from === id)
  const plain = removeNode(draft, id)
  const [before] = into
  const [after] = out
  if (
    !node ||
    into.length !== 1 ||
    out.length !== 1 ||
    !before ||
    !after ||
    before.from === id ||
    after.to === id ||
    before.from === after.to ||
    after.port !== forwardPort(node) ||
    draft.edges.some(
      (edge) => edge.from === before.from && edge.port === before.port && edge.to === after.to,
    )
  )
    return { draft: plain, note: null }
  const from = draft.nodes.find((item) => item.id === before.from)
  const to = draft.nodes.find((item) => item.id === after.to)
  if (!from || !to) return { draft: plain, note: null }
  return {
    draft: {
      ...plain,
      edges: [
        ...plain.edges,
        { id: nextEdgeId(plain), from: before.from, port: before.port, to: after.to },
      ],
    },
    note: `Joined ${from.label || from.id} to ${to.label || to.id}.`,
  }
}

export function updateNode(draft: Draft, id: string, patch: Partial<WorkflowNode>): Draft {
  return {
    ...draft,
    nodes: draft.nodes.map((node) =>
      node.id === id ? ({ ...node, ...patch } as WorkflowNode) : node,
    ),
  }
}

/** Renames a node and everything that points at it: edges, branch subjects and `{{nodes.<id>.…}}` references. */
export function renameNode(draft: Draft, from: string, to: string): Draft {
  if (from === to) return draft
  const ref = new RegExp(`(\\{\\{\\s*nodes\\.)${escapeRegExp(from)}(?=[.\\s|}])`, 'g')
  return setLayout(
    {
      ...draft,
      nodes: draft.nodes.map((node) => {
        const renamed = node.id === from ? { ...node, id: to } : node
        if (renamed.kind === 'agent')
          return { ...renamed, instruction: renamed.instruction.replace(ref, `$1${to}`) }
        if (renamed.kind === 'gate')
          return { ...renamed, question: renamed.question.replace(ref, `$1${to}`) }
        if (renamed.kind === 'branch' && renamed.subject === from)
          return { ...renamed, subject: to }
        return renamed
      }),
      edges: draft.edges.map((edge) => ({
        ...edge,
        from: edge.from === from ? to : edge.from,
        to: edge.to === from ? to : edge.to,
      })),
    },
    relayout(draft, from, to),
  )
}

/** The first way out of a node that is not a failure or a rejection (those are routes the person chooses). */
export function forwardPort(node: WorkflowNode): string | undefined {
  return portsOf(node).find((port) => port.id !== 'failed' && port.id !== 'rejected')?.id
}
