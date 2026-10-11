import {
  WORKFLOW_LIMITS,
  type BranchCondition,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeKind,
} from '@score/contract'

// The graph editing model of the workflow editor (PLAN 7.1b): pure functions over the definition the contract
// describes. The editor keeps a draft of exactly that shape, so what is saved is what was edited. Nothing here
// validates the graph rules: the server does that (`POST /api/workflows/validate`), and the editor shows its answer.

export type Draft = WorkflowDefinition
export type AgentNode = Extract<WorkflowNode, { kind: 'agent' }>
export type GateNode = Extract<WorkflowNode, { kind: 'gate' }>
export type BranchNode = Extract<WorkflowNode, { kind: 'branch' }>

export const KIND_LABEL: Record<WorkflowNodeKind, string> = {
  agent: 'Agent step',
  gate: 'Gate',
  branch: 'Branch',
  join: 'Join',
  end: 'End',
}

export const KIND_HELP: Record<WorkflowNodeKind, string> = {
  agent: 'An agent does some work from your instruction.',
  gate: 'The run stops here until you approve or reject.',
  branch: 'Sends the run down one path, by the verdict, outcome or output of an earlier step.',
  join: 'Waits for every path that leads into it.',
  end: 'The run is finished when it gets here.',
}

export interface PortInfo {
  id: string
  /** What the person reads: "when it is done", "when it fails". */
  label: string
}

/** The ports a node offers to connect from; none for an end. */
export function portsOf(node: WorkflowNode): PortInfo[] {
  switch (node.kind) {
    case 'agent':
      return [
        { id: 'ok', label: 'when done' },
        { id: 'failed', label: 'when it fails' },
      ]
    case 'gate':
      return [
        { id: 'ok', label: 'when approved' },
        { id: 'rejected', label: 'when rejected' },
      ]
    case 'branch':
      return [
        ...node.rules.map((rule) => ({ id: rule.id, label: describeCondition(rule.when) })),
        { id: 'default', label: 'otherwise' },
      ]
    case 'join':
      return [{ id: 'ok', label: 'when all arrived' }]
    case 'end':
      return []
  }
}

export function describeCondition(condition: BranchCondition): string {
  switch (condition.kind) {
    case 'verdict':
      return condition.is === 'passed' ? 'verdict passed' : 'verdict changes requested'
    case 'outcome':
      return condition.is === 'succeeded' ? 'step succeeded' : 'step failed'
    case 'output_contains':
      return `output contains "${condition.text}"`
  }
}

export function portLabel(node: WorkflowNode | undefined, port: string): string {
  return node ? (portsOf(node).find((p) => p.id === port)?.label ?? port) : port
}

// ------------------------------------------------------------------------------------------------------- ids

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

export function nextEdgeId(draft: Draft): string {
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

/** A readable id from a title the person typed ("Write the draft" -> `write-the-draft`), made unique. */
export function idFromLabel(draft: Draft, label: string, own?: string): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/^[^a-z]+/, '')
      .slice(0, 28) || 'node'
  const taken = new Set(draft.nodes.filter((n) => n.id !== own).map((n) => n.id))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`
    if (!taken.has(id)) return id
  }
}

// ------------------------------------------------------------------------------------------------------- nodes

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

export function updateNode(draft: Draft, id: string, patch: Partial<WorkflowNode>): Draft {
  return {
    ...draft,
    nodes: draft.nodes.map((node) =>
      node.id === id ? ({ ...node, ...patch } as WorkflowNode) : node,
    ),
  }
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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

// ---------------------------------------------------------------------------------------------------- connections

export type ConnectResult = { draft: Draft } | { error: string }

/** Connect `from`'s `port` to `to`. Fan-out is allowed; a duplicate, a self-loop and an edge out of an end are not. */
export function connect(draft: Draft, from: string, port: string, to: string): ConnectResult {
  const source = draft.nodes.find((node) => node.id === from)
  const target = draft.nodes.find((node) => node.id === to)
  if (!source || !target) return { error: 'Both ends of a connection must exist.' }
  if (source.kind === 'end') return { error: 'An end has nothing after it.' }
  if (!portsOf(source).some((p) => p.id === port))
    return { error: `${source.label} has no "${port}" connection.` }
  if (from === to) return { error: 'A step can’t lead back to itself.' }
  if (draft.edges.some((e) => e.from === from && e.port === port && e.to === to))
    return { error: 'Those two are already connected that way.' }
  if (draft.edges.length >= WORKFLOW_LIMITS.maxEdges)
    return { error: `A workflow can have at most ${WORKFLOW_LIMITS.maxEdges} connections.` }
  let next: Draft = {
    ...draft,
    edges: [...draft.edges, { id: nextEdgeId(draft), from, port, to }],
  }
  // A failure or rejection edge means "route it": the choice stays explicit, the editor only keeps it consistent.
  if (source.kind === 'agent' && port === 'failed' && source.onFailure !== 'route')
    next = updateNode(next, from, { onFailure: 'route' })
  if (source.kind === 'gate' && port === 'rejected' && source.onReject !== 'route')
    next = updateNode(next, from, { onReject: 'route' })
  return { draft: next }
}

export function disconnect(draft: Draft, edgeId: string): Draft {
  return { ...draft, edges: draft.edges.filter((edge) => edge.id !== edgeId) }
}

export function edgesFrom(draft: Draft, nodeId: string): WorkflowEdge[] {
  return draft.edges.filter((edge) => edge.from === nodeId)
}
export function edgesTo(draft: Draft, nodeId: string): WorkflowEdge[] {
  return draft.edges.filter((edge) => edge.to === nodeId)
}

/** Every node that can reach `nodeId` along the edges (templates may only read from these). */
export function ancestorsOf(draft: Pick<Draft, 'edges'>, nodeId: string): Set<string> {
  const found = new Set<string>()
  const stack = [nodeId]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const edge of draft.edges) {
      if (edge.to === current && !found.has(edge.from)) {
        found.add(edge.from)
        stack.push(edge.from)
      }
    }
  }
  found.delete(nodeId)
  return found
}

// ------------------------------------------------------------------------------------------------------- branches

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

// -------------------------------------------------------------------------------------------------------- inputs

export function addInput(draft: Draft): Draft {
  if (draft.inputs.length >= WORKFLOW_LIMITS.maxInputs) return draft
  const taken = new Set(draft.inputs.map((input) => input.name))
  let n = 1
  while (taken.has(`input${n}`)) n++
  return {
    ...draft,
    inputs: [
      ...draft.inputs,
      { name: `input${n}`, label: `Input ${n}`, required: true, maxChars: 2000 },
    ],
  }
}

export function removeInput(draft: Draft, name: string): Draft {
  return { ...draft, inputs: draft.inputs.filter((input) => input.name !== name) }
}

/** Renames an input and the `{{inputs.<name>}}` references in every template. */
export function renameInput(draft: Draft, from: string, to: string): Draft {
  if (from === to) return draft
  const ref = new RegExp(`(\\{\\{\\s*inputs\\.)${escapeRegExp(from)}(?=[\\s|}])`, 'g')
  return {
    ...draft,
    inputs: draft.inputs.map((input) => (input.name === from ? { ...input, name: to } : input)),
    nodes: draft.nodes.map((node) => {
      if (node.kind === 'agent')
        return { ...node, instruction: node.instruction.replace(ref, `$1${to}`) }
      if (node.kind === 'gate') return { ...node, question: node.question.replace(ref, `$1${to}`) }
      return node
    }),
  }
}

// ------------------------------------------------------------------------------------------------------- outline

export interface OutlineItem {
  id: string
  title: string
  kind: WorkflowNodeKind
  /** "when done goes to Review", one per connection. */
  connections: { edgeId: string; port: string; text: string; to: string }[]
  /** Nothing leads into it. */
  root: boolean
}

/** The text equivalent of the canvas: every node in reading order with where each of its ports leads. */
export function outlineOf(draft: Draft): OutlineItem[] {
  const byId = new Map(draft.nodes.map((n) => [n.id, n]))
  const indegree = new Map(draft.nodes.map((n) => [n.id, 0]))
  for (const edge of draft.edges)
    if (indegree.has(edge.to) && byId.has(edge.from))
      indegree.set(edge.to, indegree.get(edge.to)! + 1)
  // Kahn order, stable on the order the nodes were added; a cycle's remainder follows in that order.
  const remaining = new Map(indegree)
  const order: string[] = []
  const queue = draft.nodes.filter((n) => remaining.get(n.id) === 0).map((n) => n.id)
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const edge of draft.edges) {
      if (edge.from !== id || !remaining.has(edge.to)) continue
      remaining.set(edge.to, remaining.get(edge.to)! - 1)
      if (remaining.get(edge.to) === 0) queue.push(edge.to)
    }
  }
  for (const node of draft.nodes) if (!order.includes(node.id)) order.push(node.id)
  return order.map((id) => {
    const node = byId.get(id)!
    return {
      id,
      title: node.label,
      kind: node.kind,
      root: indegree.get(id) === 0,
      connections: edgesFrom(draft, id).map((edge) => ({
        edgeId: edge.id,
        port: edge.port,
        to: edge.to,
        text: `${portLabel(node, edge.port)} goes to ${byId.get(edge.to)?.label ?? edge.to}`,
      })),
    }
  })
}

/** The draft is the same graph, text and settings as `saved` (what Save would change nothing about). */
export function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** A value by a name people chose: own entries only, so `constructor` reads as empty, not as a function (S2-010). */
export function ownText(values: Readonly<Record<string, string>>, name: string): string {
  return Object.hasOwn(values, name) ? (values[name] ?? '') : ''
}
