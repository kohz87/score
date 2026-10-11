import type {
  GraphOutcome,
  NodeState,
  TokenKind,
  WaitingFor,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowNeedsYou,
  WorkflowRunDetail,
  WorkflowRunSummary,
} from '@score/contract'
import { NodeStateSchema } from '@score/contract'
import type { Effect, GraphEdge, GraphNode, NodeVisual } from '../orchestrations/orch-model.ts'
import { describeCondition } from './workflow-model.ts'

// How a workflow run looks (PLAN 7.1b): the definition's graph with the run's node states, the tokens as edge states and
// moving dots, and what each event of the run's history shows. Pure; the page reads the server's state and events and
// draws exactly those (nothing is invented client-side).

export function nodeVisual(state: NodeState): NodeVisual {
  switch (state) {
    case 'waiting':
      return 'waiting'
    case 'ready':
      return 'ready'
    case 'gate_open':
      return 'gate'
    case 'running':
      return 'running'
    case 'succeeded':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'skipped':
      return 'skipped'
    case 'cancelled':
      return 'cancelled'
    case 'unresolved':
      return 'abandoned'
  }
}

export const waitingText: Record<WaitingFor, string> = {
  budget: 'waiting for budget',
  unknown_spend: 'waiting: spend unknown',
  capacity: 'waiting for a free slot',
  agent_capacity: 'waiting: agent is busy',
  quota: 'waiting for storage',
  fence: 'waiting: starting work is blocked',
  run_hold: 'waiting: the run is paused',
  agent_hold: 'waiting: the agent is paused',
  agent_unavailable: 'waiting: agent not available',
  hermes_unavailable: 'waiting: Hermes is unavailable',
  remap: 'waiting for your decision on a replaced agent',
  refusal_limit: 'Hermes keeps refusing this step',
}

// ------------------------------------------------------------------------------------------------------- graph

const edgeKindOf = (
  node: WorkflowDefinition['nodes'][number] | undefined,
  port: string,
): { kind: GraphEdge['kind']; label?: string } => {
  if (!node) return { kind: 'ok' }
  switch (node.kind) {
    case 'agent':
      return port === 'failed' ? { kind: 'failed', label: 'if it fails' } : { kind: 'ok' }
    case 'gate':
      return port === 'rejected'
        ? { kind: 'rejected', label: 'rejected' }
        : { kind: 'ok', label: 'approved' }
    case 'branch': {
      if (port === 'default') return { kind: 'default', label: 'otherwise' }
      const rule = node.rules.find((r) => r.id === port)
      return { kind: 'branch', label: rule ? describeCondition(rule.when) : port }
    }
    default:
      return { kind: 'ok' }
  }
}

/** The words on an edge leaving `node` through `port` (none for the plain "done" path). */
export const edgeLabelOf = (
  node: WorkflowDefinition['nodes'][number] | undefined,
  port: string,
): string | undefined => edgeKindOf(node, port).label

/** The graph the diagram draws, from the run's frozen definition. */
export function buildWorkflowGraph(
  definition: Pick<WorkflowDefinition, 'nodes' | 'edges'>,
  captions: ReadonlyMap<string, string> = new Map(),
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const byId = new Map(definition.nodes.map((node) => [node.id, node]))
  return {
    nodes: definition.nodes.map((node) => ({
      id: node.id,
      kind: 'step' as const,
      agentId: node.kind === 'agent' ? node.agentId : '',
      label: node.label,
      title: node.label,
      shape: node.kind,
      ...(captions.has(node.id) ? { caption: captions.get(node.id)! } : {}),
    })),
    edges: definition.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      ...edgeKindOf(byId.get(edge.from), edge.port),
    })),
  }
}

/** Which edges a token went along, and which were passed over. Start tokens belong to no drawn edge. */
export function edgeStatesOf(
  tokens: readonly { edgeId: string; kind: TokenKind }[],
): Map<string, 'taken' | 'skipped'> {
  const states = new Map<string, 'taken' | 'skipped'>()
  for (const token of tokens) {
    if (token.edgeId.startsWith('start:')) continue
    states.set(token.edgeId, token.kind === 'skip' ? 'skipped' : 'taken')
  }
  return states
}

/** What a node says under its title when the plain state word is not enough. */
export function captionsOf(run: WorkflowRunDetail): Map<string, string> {
  const captions = new Map<string, string>()
  const taken = new Map(
    run.tokens.filter((t) => t.kind === 'branch').map((t) => [t.edgeId, t] as const),
  )
  for (const node of run.nodeStates) {
    const def = run.definition.nodes.find((n) => n.id === node.nodeId)
    if (!def) continue
    if (def.kind === 'branch' && node.state === 'succeeded') {
      const edge = run.definition.edges.find((e) => e.from === def.id && taken.has(e.id))
      if (edge)
        captions.set(def.id, `took ${edgeKindOf(def, edge.port).label ?? edge.port}`.slice(0, 30))
    } else if (def.kind === 'agent') {
      const base = nodeVisualWord(node.state)
      if (node.state === 'ready' && node.waitingFor)
        captions.set(def.id, waitingText[node.waitingFor].slice(0, 34))
      else if (node.attemptsMax > 1 && node.attemptsUsed > 0)
        captions.set(def.id, `${base} · try ${node.attemptsUsed}/${node.attemptsMax}`)
    }
  }
  return captions
}

const nodeVisualWord = (state: NodeState): string =>
  state === 'gate_open' ? 'needs you' : state === 'unresolved' ? 'abandoned' : state

export function liveWorkflowVisuals(run: WorkflowRunDetail): Map<string, NodeVisual> {
  return new Map(run.nodeStates.map((node) => [node.nodeId, nodeVisual(node.state)]))
}

// ------------------------------------------------------------------------------------------------------- events

/** Edge endpoints by id, to find where a token's dot travels. */
export const edgeIndex = (
  definition: Pick<WorkflowDefinition, 'edges'>,
): Map<string, { from: string; to: string }> =>
  new Map(definition.edges.map((edge) => [edge.id, { from: edge.from, to: edge.to }]))

/**
 * What a recorded event shows on the diagram. A dot travels only where a token really travelled (the event names the
 * edge); everything else lights one node.
 */
export function workflowEventEffect(
  event: WorkflowEvent,
  edges: ReadonlyMap<string, { from: string; to: string }>,
  tokenKinds: ReadonlyMap<string, TokenKind>,
  nodeIds: ReadonlySet<string>,
): Effect | null {
  const base = { eventId: event.id }
  const node = event.nodeId && nodeIds.has(event.nodeId) ? event.nodeId : null
  switch (event.kind) {
    case 'token': {
      if (!event.edgeId) return null
      const edge = edges.get(event.edgeId)
      const kind = tokenKinds.get(event.edgeId)
      if (kind === 'skip') return null
      if (!edge) {
        // A start token belongs to no edge: it lights the node it starts.
        const start = event.edgeId.startsWith('start:') ? event.edgeId.slice(6) : null
        return start && nodeIds.has(start)
          ? { ...base, kind: 'pulse', from: start, to: start, tone: 'ok' }
          : null
      }
      return {
        ...base,
        edge: event.edgeId,
        kind: 'dot',
        from: edge.from,
        to: edge.to,
        tone: kind === 'failed' || kind === 'rejected' ? 'fail' : 'ok',
      }
    }
    case 'node_state': {
      if (!node) return null
      const state = NodeStateSchema.safeParse(event.verdict)
      if (!state.success) return null
      switch (state.data) {
        case 'gate_open':
          return { ...base, kind: 'pulse', from: node, to: node, tone: 'need' }
        case 'failed':
        case 'unresolved':
          return { ...base, kind: 'pulse', from: node, to: node, tone: 'fail' }
        case 'running':
        case 'succeeded':
          return { ...base, kind: 'pulse', from: node, to: node, tone: 'ok' }
        default:
          return null
      }
    }
    case 'gate_decided':
      return node
        ? {
            ...base,
            kind: 'pulse',
            from: node,
            to: node,
            tone: event.verdict === 'rejected' ? 'refused' : 'ok',
          }
        : null
    case 'planner':
      return node ? { ...base, kind: 'pulse', from: node, to: node, tone: 'refused' } : null
    default:
      return null
  }
}

export interface WorkflowReplayState {
  nodes: Map<string, NodeVisual>
  edges: Map<string, 'taken' | 'skipped'>
  shown: number
}

/** The diagram once the first `count` events have happened: every node starts waiting, tokens and states follow. */
export function workflowReplayAt(
  events: readonly WorkflowEvent[],
  count: number,
  nodeIds: readonly string[],
  tokenKinds: ReadonlyMap<string, TokenKind>,
): WorkflowReplayState {
  const nodes = new Map<string, NodeVisual>(nodeIds.map((id) => [id, 'waiting']))
  const edges = new Map<string, 'taken' | 'skipped'>()
  const upTo = Math.max(0, Math.min(count, events.length))
  for (let i = 0; i < upTo; i++) {
    const event = events[i]!
    if (event.kind === 'node_state' && event.nodeId && nodes.has(event.nodeId)) {
      const state = NodeStateSchema.safeParse(event.verdict)
      if (state.success) nodes.set(event.nodeId, nodeVisual(state.data))
    } else if (event.kind === 'token' && event.edgeId && !event.edgeId.startsWith('start:')) {
      edges.set(event.edgeId, tokenKinds.get(event.edgeId) === 'skip' ? 'skipped' : 'taken')
    }
  }
  return { nodes, edges, shown: upTo }
}

export function filterWorkflowLog<T extends { nodeId: string | null }>(
  events: readonly T[],
  node: string | null,
): T[] {
  return node === null ? [...events] : events.filter((event) => event.nodeId === node)
}

// ------------------------------------------------------------------------------------------------------- status

export const graphOutcomeLabel: Record<GraphOutcome, string> = {
  reached_end: 'Workflow reached its end',
  failed: 'Workflow failed',
  stopped: 'Workflow stopped',
}

/**
 * Two statements, never one: the executor's status and what the graph did. "Finished, not everything confirmed" next to
 * “Workflow reached its end” is how an abandoned attempt that was retried reads; the server's note says so in words.
 */
export function outcomeLines(run: Pick<WorkflowRunSummary, 'graphOutcome' | 'outcomeNote'>): {
  graph: string | null
  note: string | null
} {
  return {
    graph: run.graphOutcome ? graphOutcomeLabel[run.graphOutcome] : null,
    note: run.outcomeNote,
  }
}

export function workflowNeedsText(
  item: WorkflowNeedsYou,
  nodeLabel: (id: string) => string,
): string {
  switch (item.kind) {
    case 'gate':
      return item.gateKind === 'node'
        ? `Decide on ${nodeLabel(item.nodeId)}`
        : `Approve ${nodeLabel(item.nodeId)}`
    case 'budget':
      return item.reason === 'unknown_spend'
        ? 'Spend is unknown: decide whether to continue'
        : item.reason === 'deadline'
          ? 'The deadline passed'
          : 'The budget is used up'
    case 'paused':
      return 'The run is paused'
    case 'unknown':
      return 'Some work isn’t confirmed as ended'
    case 'cancel_fence':
      return `Stopped ${item.stepId} may still be running`
    case 'fence':
      return 'Starting work is blocked until you review a list'
    case 'retry':
      return `You stopped waiting for ${nodeLabel(item.nodeId)}: retry or stop`
    case 'remap':
      return `${item.agentId} was replaced: decide whether this run uses the new one`
    case 'refusal_limit':
      return `Hermes refused ${nodeLabel(item.nodeId)} ${item.refusals} times`
  }
}

// ------------------------------------------------------------------------------------------------------- the log

export interface WorkflowLogLine {
  id: string
  at: string
  kind: string
  verdict: string | null
  summary: string
}

const reasonOf = (summary: string): string | null => /\(([^()]*)\)\s*$/.exec(summary)?.[1] ?? null

/**
 * The run's history in the person's words: node titles, the port or rule an edge belongs to, nothing internal. The
 * server's own summary lines name ids and states; this maps each event with the run's frozen definition instead.
 * Events that only repeat another line (start tokens, passed-over edges, a branch's own "succeeded") have no line.
 */
export function describeWorkflowEvents(
  events: readonly WorkflowEvent[],
  run: Pick<WorkflowRunDetail, 'definition' | 'tokens'>,
  agentName: (agentId: string) => string,
): WorkflowLogLine[] {
  const nodes = new Map(run.definition.nodes.map((node) => [node.id, node]))
  const edges = new Map(run.definition.edges.map((edge) => [edge.id, edge]))
  const tokenKinds = new Map(run.tokens.map((token) => [token.edgeId, token.kind]))
  const title = (id: string | null) => (id ? (nodes.get(id)?.label ?? id) : 'a step')
  const line = (event: WorkflowEvent, summary: string | null): WorkflowLogLine[] =>
    summary === null
      ? []
      : [{ id: event.id, at: event.at, kind: event.kind, verdict: event.verdict, summary }]
  return events.flatMap((event): WorkflowLogLine[] => {
    const node = event.nodeId ? nodes.get(event.nodeId) : undefined
    const name = title(event.nodeId)
    switch (event.kind) {
      case 'run_started':
        return line(event, 'Run started')
      case 'node_state': {
        const reason = reasonOf(event.summary)
        switch (event.verdict) {
          case 'ready':
            return line(event, `${name} is ready${reason ? ` (${reason})` : ''}`)
          case 'running':
            return line(
              event,
              node?.kind === 'agent'
                ? `${name} started (${agentName(node.agentId)})`
                : `${name} started`,
            )
          case 'gate_open':
            return line(event, `${name} is waiting for you`)
          case 'succeeded':
            if (node?.kind === 'agent') return line(event, `${name} finished`)
            if (node?.kind === 'end') return line(event, `The run reached ${name}`)
            return []
          case 'failed':
            return line(event, `${name} failed${reason ? `: ${reason}` : ''}`)
          case 'skipped':
            return line(event, `${name} was skipped`)
          case 'cancelled':
            return line(event, `${name} was stopped`)
          case 'unresolved':
            return line(event, `You stopped waiting for ${name}: retry it or stop the run`)
          default:
            return []
        }
      }
      case 'token': {
        const edge = event.edgeId ? edges.get(event.edgeId) : undefined
        if (!edge) return []
        const kind = tokenKinds.get(edge.id)
        const from = title(edge.from)
        const to = title(edge.to)
        if (kind === 'skip') return []
        if (kind === 'failed') return line(event, `${from} failed → ${to}`)
        if (kind === 'rejected') return line(event, `You rejected ${from} → ${to}`)
        if (kind === 'branch') {
          const source = nodes.get(edge.from)
          const label = source ? edgeLabelOf(source, edge.port) : undefined
          return line(event, `${from} took '${label ?? edge.port}' → ${to}`)
        }
        return line(event, `${from} → ${to}`)
      }
      case 'gate_decided': {
        const decided = event.summary.includes('rejected')
          ? 'rejected'
          : event.summary.includes('approved')
            ? 'approved'
            : null
        const produced = run.tokens.find((t) => t.producedBy === event.nodeId)
        const how = decided ?? (produced?.kind === 'rejected' ? 'rejected' : 'approved')
        return line(event, event.nodeId ? `You ${how} ${name}` : `You ${how} a step`)
      }
      case 'planner': {
        if (event.summary.includes('retried')) return line(event, `${name} is being retried`)
        if (event.summary.includes('try again'))
          return line(event, `${name} is being sent to Hermes again`)
        return line(
          event,
          `${name} couldn’t start${reasonOf(event.summary) ? `: ${reasonOf(event.summary)}` : ''}`,
        )
      }
      case 'graph_end':
        return line(event, 'Every path is done; finishing the run')
      case 'control': {
        const s = event.summary
        const text = s.startsWith('paused')
          ? 'The run was paused'
          : s.startsWith('resumed')
            ? 'The run was resumed'
            : s.startsWith('stop requested')
              ? 'You asked to stop the run'
              : s.startsWith('limits')
                ? 'The budget or deadline was changed'
                : s.startsWith('abandoned')
                  ? 'You stopped waiting for work that wasn’t confirmed as ended'
                  : s.startsWith('waiver')
                    ? 'You chose to continue while a stopped step may still run'
                    : s.startsWith('agent remapped')
                      ? 'The run now uses a replaced agent'
                      : s.startsWith('ended')
                        ? 'The run ended'
                        : s
        return line(event, text)
      }
      default:
        return line(event, event.summary)
    }
  })
}
