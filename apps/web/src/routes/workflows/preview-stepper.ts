import type { WorkflowDefinition } from '@score/contract'
import type { Effect, NodeVisual } from '../orchestrations/orch-model.ts'
import { portsOf } from './workflow-model.ts'

// PLAN 5.39: the workflow editor's preview. A pure walk through the drawn graph, one step at a time, with no server and
// no agents: every agent step "succeeds", a gate waits for a choice (approved or rejected) and a branch asks which way
// to go. The state it returns is drawn by the same diagram as a live run.

export type PreviewDefinition = Pick<WorkflowDefinition, 'nodes' | 'edges'>

export type PreviewPause =
  | { kind: 'gate'; nodeId: string; onReject: 'route' | 'stop_run' }
  | { kind: 'branch'; nodeId: string; options: { port: string; label: string }[] }

export interface PreviewState {
  /** Where each step is: waiting (not reached), running, gate (waiting for you), succeeded, rejected or skipped. */
  nodes: ReadonlyMap<string, NodeVisual>
  edges: ReadonlyMap<string, 'taken' | 'skipped'>
  /** Steps that hold a token and have not finished, oldest first. */
  active: readonly string[]
  /** The question the preview is waiting on; nothing moves until it is answered. */
  pause: PreviewPause | null
  status: 'running' | 'paused' | 'done' | 'stopped'
  /** What the last step showed: dots along taken edges, a pulse on a node. */
  effects: readonly Effect[]
  /** Steps taken so far. */
  steps: number
}

const MAX_STEPS = 500

const incoming = (def: PreviewDefinition, nodeId: string) =>
  def.edges.filter((edge) => edge.to === nodeId)

/** The label of a branch outcome as the person reads it. */
function branchOptions(node: Extract<PreviewDefinition['nodes'][number], { kind: 'branch' }>) {
  return portsOf(node).map((port) => ({ port: port.id, label: port.label }))
}

interface Work {
  nodes: Map<string, NodeVisual>
  edges: Map<string, 'taken' | 'skipped'>
  active: string[]
  effects: Effect[]
  counter: number
}

const tone = (port: string) => (port === 'failed' || port === 'rejected' ? 'fail' : 'ok')

function effectId(work: Work) {
  return `preview-${work.counter++}`
}

/** Gives a step its token: it starts running, or (a join) waits until every path into it is settled. */
function arrive(def: PreviewDefinition, work: Work, nodeId: string) {
  const node = def.nodes.find((item) => item.id === nodeId)
  if (!node || work.nodes.get(nodeId) !== 'waiting') return
  const edges = incoming(def, nodeId)
  const settled = edges.every((edge) => work.edges.has(edge.id))
  const anyTaken = edges.some((edge) => work.edges.get(edge.id) === 'taken')
  if (node.kind === 'join' ? settled && anyTaken : anyTaken || edges.length === 0) {
    work.nodes.set(nodeId, node.kind === 'gate' ? 'gate' : 'running')
    work.active.push(nodeId)
    work.effects.push({
      eventId: effectId(work),
      kind: 'pulse',
      from: nodeId,
      to: nodeId,
      tone: node.kind === 'gate' ? 'need' : 'ok',
    })
  } else if (settled && !anyTaken) skip(def, work, nodeId)
}

/** A step nothing reached: it is passed over, and so is everything that only it could have led to. */
function skip(def: PreviewDefinition, work: Work, nodeId: string) {
  if (work.nodes.get(nodeId) !== 'waiting') return
  work.nodes.set(nodeId, 'skipped')
  for (const edge of def.edges.filter((item) => item.from === nodeId)) {
    work.edges.set(edge.id, 'skipped')
    arrive(def, work, edge.to)
  }
}

/** A step is over: the ports in `taken` send a token along their edges, every other port is passed over. */
function leave(def: PreviewDefinition, work: Work, nodeId: string, taken: ReadonlySet<string>) {
  const outgoing = def.edges.filter((edge) => edge.from === nodeId)
  for (const edge of outgoing) {
    if (taken.has(edge.port)) {
      work.edges.set(edge.id, 'taken')
      work.effects.push({
        eventId: effectId(work),
        edge: edge.id,
        kind: 'dot',
        from: nodeId,
        to: edge.to,
        tone: tone(edge.port),
      })
    } else work.edges.set(edge.id, 'skipped')
  }
  for (const edge of outgoing) arrive(def, work, edge.to)
}

const clone = (state: PreviewState): Work => ({
  nodes: new Map(state.nodes),
  edges: new Map(state.edges),
  active: [...state.active],
  effects: [],
  counter: state.steps * 100,
})

/** The pause the head of the queue asks for, if any. */
function pauseFor(def: PreviewDefinition, work: Work): PreviewPause | null {
  const head = work.active[0]
  const node = head ? def.nodes.find((item) => item.id === head) : undefined
  if (node?.kind === 'gate') return { kind: 'gate', nodeId: node.id, onReject: node.onReject }
  if (node?.kind === 'branch')
    return { kind: 'branch', nodeId: node.id, options: branchOptions(node) }
  return null
}

function settle(state: PreviewState, def: PreviewDefinition, work: Work): PreviewState {
  const pause = pauseFor(def, work)
  return {
    nodes: work.nodes,
    edges: work.edges,
    active: work.active,
    pause,
    status: pause ? 'paused' : work.active.length === 0 ? 'done' : 'running',
    effects: work.effects,
    steps: state.steps + 1,
  }
}

/** The first state: steps with nothing leading into them have their token. */
export function startPreview(def: PreviewDefinition): PreviewState {
  const work: Work = {
    nodes: new Map(def.nodes.map((node) => [node.id, 'waiting' as NodeVisual])),
    edges: new Map(),
    active: [],
    effects: [],
    counter: 0,
  }
  for (const node of def.nodes) if (incoming(def, node.id).length === 0) arrive(def, work, node.id)
  const pause = pauseFor(def, work)
  return {
    nodes: work.nodes,
    edges: work.edges,
    active: work.active,
    pause,
    status: pause ? 'paused' : work.active.length === 0 ? 'done' : 'running',
    effects: work.effects,
    steps: 0,
  }
}

/** The branch outcome followed when the person doesn't choose: the first rule. */
export const defaultChoice = (pause: PreviewPause): string =>
  pause.kind === 'branch' ? (pause.options[0]?.port ?? 'default') : 'ok'

/**
 * Finishes the oldest step. A gate takes `choice` 'ok' (approved) or 'rejected'; a branch takes the port to follow.
 * Without an answer, a step that waits for one stays where it is.
 */
export function stepPreview(
  state: PreviewState,
  def: PreviewDefinition,
  choice?: string,
): PreviewState {
  if (state.status === 'done' || state.status === 'stopped' || state.steps >= MAX_STEPS)
    return { ...state, status: state.status === 'stopped' ? 'stopped' : 'done', effects: [] }
  const head = state.active[0]
  const node = head ? def.nodes.find((item) => item.id === head) : undefined
  if (!head || !node) return { ...state, status: 'done', effects: [] }
  if (state.pause && choice === undefined) return { ...state, effects: [] }
  const work = clone(state)
  work.active.shift()
  switch (node.kind) {
    case 'gate': {
      const approved = choice !== 'rejected'
      work.nodes.set(head, approved ? 'succeeded' : 'rejected')
      if (!approved && node.onReject === 'stop_run') {
        // Rejecting stops the run: nothing else moves.
        for (const [id, visual] of work.nodes)
          if (visual === 'waiting' || visual === 'running') work.nodes.set(id, 'cancelled')
        return {
          nodes: work.nodes,
          edges: work.edges,
          active: [],
          pause: null,
          status: 'stopped',
          effects: [],
          steps: state.steps + 1,
        }
      }
      leave(def, work, head, new Set([approved ? 'ok' : 'rejected']))
      break
    }
    case 'branch': {
      const ports = new Set(branchOptions(node).map((option) => option.port))
      const port = choice !== undefined && ports.has(choice) ? choice : 'default'
      work.nodes.set(head, 'succeeded')
      leave(def, work, head, new Set([port]))
      break
    }
    case 'end':
      work.nodes.set(head, 'succeeded')
      break
    default:
      // An agent step or a join: done, and only the "done" path is followed (the "fails" path is passed over).
      work.nodes.set(head, 'succeeded')
      leave(def, work, head, new Set(['ok']))
  }
  return settle(state, def, work)
}
