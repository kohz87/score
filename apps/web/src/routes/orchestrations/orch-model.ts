import type {
  WorkerReadiness,
  AttemptView,
  NeedsYou,
  OrchEvent,
  OrchestrationDetail,
  StepStatus,
  StepView,
} from '@score/contract'
import type { RunCoding } from './CodingCards.tsx'
import { heldCaption, heldNeedsText } from './quota-text.ts'

// Pure model of the orchestration pages: how a step looks, which graph the diagram draws, which events move a dot,
// how the live log is filtered and what the diagram shows at a scrubbed time of the replay. No React, no DOM.

export const LEAD_NODE = 'lead'

/** What a node looks like. Every state has a shape/text cue as well as a colour (AGENTS.md: never colour alone). */
export type NodeVisual =
  | 'queued'
  | 'gate'
  | 'admitting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'abandoned'
  | 'blocked'
  | 'rejected'
  | 'not_started'
  // Workflow nodes (7.1b): not reached yet, ready but waiting for a condition, passed over by a branch.
  | 'waiting'
  | 'ready'
  | 'skipped'

export const visualLabel: Record<NodeVisual, string> = {
  queued: 'queued',
  gate: 'needs you',
  admitting: 'starting',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'stopped',
  unknown: 'not confirmed as ended',
  abandoned: 'stopped waiting',
  blocked: 'blocked',
  rejected: 'rejected',
  not_started: 'not started',
  waiting: 'waiting',
  ready: 'ready',
  skipped: 'skipped',
}

export function stepVisual(
  step: Pick<StepView, 'status'>,
  attempt?: Pick<AttemptView, 'state' | 'abandonedAt'> | null,
): NodeVisual {
  const status: StepStatus = step.status
  switch (status) {
    case 'pending_gate':
      return 'gate'
    case 'queued':
      return 'queued'
    case 'admitted':
      return attempt && (attempt.state === 'created' || attempt.state === 'send_started')
        ? 'admitting'
        : 'running'
    case 'unknown':
      return attempt?.abandonedAt ? 'abandoned' : 'unknown'
    default:
      return status
  }
}

/** Steps that are over, one way or another. */
export const isSettledVisual = (visual: NodeVisual): boolean =>
  [
    'succeeded',
    'failed',
    'cancelled',
    'blocked',
    'rejected',
    'not_started',
    'abandoned',
    'skipped',
  ].includes(visual)

// ------------------------------------------------------------------------------------------------------ the graph

export interface GraphNode {
  id: string
  kind: 'lead' | 'step'
  agentId: string
  label: string
  /** Workflow nodes (7.1b): what kind of node it is; absent for orchestration steps. */
  shape?: 'agent' | 'gate' | 'branch' | 'join' | 'end'
  /** Shown instead of the id. */
  title?: string
  /** Replaces the state word on the second line (for example the branch's rule count). */
  caption?: string
  /** What the agent is doing now (PLAN 5.39): shown on the second line while the step runs; the state word stays in the accessible name. */
  status?: string
}
export interface GraphEdge {
  id: string
  from: string
  to: string
  kind: 'assign' | 'after' | 'replaces' | 'ok' | 'failed' | 'rejected' | 'branch' | 'default'
  /** Drawn on the edge (a workflow port: "failed", a branch rule). */
  label?: string
}

/** A lead node plus one node per step; edges from `after` and `replaces` (dashed); the lead feeds steps with no `after`. */
export function buildGraph(
  detail: Pick<OrchestrationDetail, 'leadAgentId' | 'stepsList'>,
  visibleSteps?: ReadonlySet<string>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const steps = detail.stepsList.filter((step) => !visibleSteps || visibleSteps.has(step.id))
  const ids = new Set(steps.map((step) => step.id))
  const nodes: GraphNode[] = [
    { id: LEAD_NODE, kind: 'lead', agentId: detail.leadAgentId, label: 'Lead' },
    ...steps.map((step) => ({
      id: step.id,
      kind: 'step' as const,
      agentId: step.agentId,
      label: step.id,
      // A step held for a low limit says so on the diagram (8.6).
      ...(step.quotaHold ? { caption: heldCaption(step.quotaHold) } : {}),
    })),
  ]
  const edges: GraphEdge[] = []
  for (const step of steps) {
    const deps = step.after.filter((id) => ids.has(id))
    if (deps.length === 0 && (!step.replaces || !ids.has(step.replaces)))
      edges.push({ id: `lead>${step.id}`, from: LEAD_NODE, to: step.id, kind: 'assign' })
    for (const dep of deps)
      edges.push({ id: `${dep}>${step.id}`, from: dep, to: step.id, kind: 'after' })
    if (step.replaces && ids.has(step.replaces))
      edges.push({
        id: `${step.replaces}~>${step.id}`,
        from: step.replaces,
        to: step.id,
        kind: 'replaces',
      })
  }
  return { nodes, edges }
}

// ----------------------------------------------------------------------------------------- events become effects

export type EffectTone = 'ok' | 'refused' | 'need' | 'fail'
export interface Effect {
  /** The event that caused it: an effect is never created without one. */
  eventId: string
  /** The edge a dot travels on, when the event names one (workflow tokens). */
  edge?: string
  kind: 'dot' | 'pulse'
  /** Node ids. A pulse lights `to`. */
  from: string
  to: string
  tone: EffectTone
}

/**
 * What a recorded event shows on the diagram. A dot travels only where a real hand-off happened: lead → step when
 * an assignment was accepted, step → lead when its result was. Everything else lights one node.
 */
export function eventEffect(event: OrchEvent, known: ReadonlySet<string>): Effect | null {
  const step = event.stepId && known.has(event.stepId) ? event.stepId : null
  const base = { eventId: event.id }
  switch (event.kind) {
    case 'lead_wake':
      return { ...base, kind: 'pulse', from: LEAD_NODE, to: LEAD_NODE, tone: 'ok' }
    case 'command':
      if (event.verdict === 'accepted') {
        if (event.tool === 'orch.assign' && step)
          return { ...base, kind: 'dot', from: LEAD_NODE, to: step, tone: 'ok' }
        return { ...base, kind: 'pulse', from: LEAD_NODE, to: LEAD_NODE, tone: 'ok' }
      }
      return { ...base, kind: 'pulse', from: LEAD_NODE, to: LEAD_NODE, tone: 'refused' }
    case 'step_result':
      if (!step) return null
      return {
        ...base,
        kind: 'dot',
        from: step,
        to: LEAD_NODE,
        tone: event.verdict === 'succeeded' ? 'ok' : 'fail',
      }
    case 'step_admitted':
      return step ? { ...base, kind: 'pulse', from: step, to: step, tone: 'ok' } : null
    case 'gate_opened':
      return step ? { ...base, kind: 'pulse', from: step, to: step, tone: 'need' } : null
    case 'gate_decided':
      return step
        ? {
            ...base,
            kind: 'pulse',
            from: step,
            to: step,
            tone: event.verdict === 'approved' ? 'ok' : 'refused',
          }
        : null
    case 'step_state':
      return step ? { ...base, kind: 'pulse', from: step, to: step, tone: 'refused' } : null
    case 'inquiry_opened':
      return { ...base, kind: 'pulse', from: LEAD_NODE, to: LEAD_NODE, tone: 'need' }
    case 'control':
      return event.verdict === 'stop_requested'
        ? { ...base, kind: 'pulse', from: LEAD_NODE, to: LEAD_NODE, tone: 'refused' }
        : null
    default:
      return null
  }
}

/** Events in `next` whose ids were not in `seen`, in order. */
export const freshEvents = (seen: ReadonlySet<string>, next: readonly OrchEvent[]): OrchEvent[] =>
  next.filter((event) => !seen.has(event.id))

/**
 * Effects wait their turn: one starts per `gapMs` at the earliest, so a burst of events stays readable. Bounded: when
 * far behind (a hidden tab, a long burst) the oldest are dropped and counted, never replayed in a rush.
 */
export class EffectQueue {
  private items: Effect[] = []
  private lastStart = Number.NEGATIVE_INFINITY
  dropped = 0
  constructor(
    readonly gapMs = 300,
    private readonly max = 40,
  ) {}
  push(effects: Effect[]): void {
    this.items.push(...effects)
    const extra = this.items.length - this.max
    if (extra > 0) {
      this.items.splice(0, extra)
      this.dropped += extra
    }
  }
  get length(): number {
    return this.items.length
  }
  /** The next effect to start at `now` (ms), or null when it is not yet its turn. */
  take(now: number): Effect | null {
    if (this.items.length === 0 || now - this.lastStart < this.gapMs) return null
    this.lastStart = now
    return this.items.shift() ?? null
  }
  /** Milliseconds until the next effect may start (0 when one may start now or the queue is empty). */
  wait(now: number): number {
    return this.items.length === 0 ? 0 : Math.max(0, this.lastStart + this.gapMs - now)
  }
  clear(): void {
    this.items = []
  }
}

// ------------------------------------------------------------------------------------------------------- the log

export type LogFilter = { node: string | null }

/**
 * Per-node filtering: a step's node shows what happened to that step; the lead's node shows the lead's turns, its
 * commands and the run-level events. `null` shows everything.
 */
export function filterLog(events: readonly OrchEvent[], filter: LogFilter): OrchEvent[] {
  const node = filter.node
  if (node === null) return [...events]
  if (node === LEAD_NODE)
    return events.filter(
      (event) =>
        event.kind === 'run_started' ||
        event.kind === 'lead_wake' ||
        event.kind === 'lead_done' ||
        event.kind === 'command' ||
        event.kind === 'inquiry_opened' ||
        event.kind === 'inquiry_answered' ||
        event.kind === 'control',
    )
  return events.filter((event) => event.stepId === node)
}

// ----------------------------------------------------------------------------------------------------- replay

export interface ReplayState {
  /** Steps that exist at this time, with how they look. */
  steps: Map<string, NodeVisual>
  lead: 'idle' | 'working' | 'ended'
  /** The last `n` events are shown in the log. */
  shown: number
  /** The run-level status the events so far imply (best effort; the live status comes from the snapshot). */
  note: string
}

/** What the diagram shows once the first `count` events have happened. Computed from events only. */
export function replayAt(events: readonly OrchEvent[], count: number): ReplayState {
  const steps = new Map<string, NodeVisual>()
  let lead: ReplayState['lead'] = 'idle'
  let note = 'Not started'
  const upTo = Math.max(0, Math.min(count, events.length))
  for (let i = 0; i < upTo; i++) {
    const event = events[i]!
    const id = event.stepId
    switch (event.kind) {
      case 'run_started':
        note = 'Started'
        break
      case 'lead_wake':
        lead = 'working'
        break
      case 'lead_done':
        lead = 'idle'
        break
      case 'command':
        if (event.verdict === 'accepted' && event.tool === 'orch.assign' && id)
          steps.set(id, 'queued')
        else if (event.verdict === 'accepted' && event.tool === 'orch.cancel' && id)
          steps.set(id, 'cancelled')
        break
      case 'gate_opened':
        if (id) steps.set(id, 'gate')
        break
      case 'gate_decided':
        if (id)
          steps.set(
            id,
            event.verdict === 'approved'
              ? 'queued'
              : event.verdict === 'rejected'
                ? 'rejected'
                : 'not_started',
          )
        break
      case 'step_admitted':
        if (id) steps.set(id, 'running')
        break
      case 'step_result':
        if (id) steps.set(id, event.verdict === 'succeeded' ? 'succeeded' : 'failed')
        break
      case 'step_state':
        if (id)
          steps.set(
            id,
            event.verdict === 'blocked'
              ? 'blocked'
              : event.verdict === 'abandoned'
                ? 'abandoned'
                : 'unknown',
          )
        break
      case 'control':
        if (event.verdict === 'stop_requested' || event.verdict === 'finish_requested') {
          for (const [step, visual] of steps)
            if (visual === 'queued' || visual === 'gate') steps.set(step, 'not_started')
        }
        if (event.verdict === 'ended') {
          lead = 'ended'
          note = event.summary
        }
        break
      default:
        break
    }
  }
  return { steps, lead, shown: upTo, note }
}

/** The pause the replay waits after an event before showing the next, at 1x: the recorded gap, kept readable. */
export function replayDelayMs(
  events: readonly Pick<OrchEvent, 'at'>[],
  index: number,
  speed: 1 | 4 | 16,
): number {
  const a = events[index]
  const b = events[index + 1]
  if (!a || !b) return 0
  const gap = Date.parse(b.at) - Date.parse(a.at)
  const readable = Math.min(3000, Math.max(300, Number.isFinite(gap) ? gap : 300))
  return Math.round(readable / speed)
}

// ----------------------------------------------------------------------------------------------- needs-you text

export function needsYouText(item: NeedsYou): string {
  switch (item.kind) {
    case 'gate':
      return `Approve ${item.stepId}`
    case 'inquiry':
      return 'The lead has a question'
    case 'budget':
      return item.reason === 'unknown_spend'
        ? 'Spend is unknown: decide whether to continue'
        : item.reason === 'deadline'
          ? 'The deadline passed'
          : 'The budget is used up'
    case 'paused':
      return pauseReasonText(item.reason)
    case 'unknown':
      return 'Some work isn’t confirmed as ended'
    case 'cancel_fence':
      return `Stopped ${item.stepId} may still be running`
    case 'remap':
      return `${item.agentId} was replaced: decide whether this run uses the new one`
    case 'fence':
      return 'Starting work is blocked until you review a list'
    case 'policy_changed':
      return `${item.agentId}’s settings changed: decide whether ${item.stepId} uses the new ones`
    case 'coding_limit':
      return `${item.stepId} is waiting: the run reached its limit of coding steps`
    case 'quota_low':
      return heldNeedsText(item.stepId, item.agentId)
  }
}

export function pauseReasonText(reason: string | null): string {
  switch (reason) {
    case 'person':
      return 'Paused by you'
    case 'budget':
      return 'Paused: the budget is used up'
    case 'unknown_spend':
      return 'Paused: some spend is unknown'
    case 'deadline':
      return 'Paused: the deadline passed'
    case 'no_wake_source':
      return 'Paused: nothing is left that could wake the lead'
    case 'turns_exhausted':
      return 'Paused: the lead has used all its turns'
    case 'lead_failing':
      return 'Paused: the lead keeps failing'
    case 'agent_unavailable':
      return 'Paused: an agent isn’t available'
    case 'abandonment':
      return 'Paused after you stopped waiting for some work'
    default:
      return 'Paused'
  }
}

export const statusLabel: Record<OrchestrationDetail['status'], string> = {
  running: 'Running',
  paused: 'Paused',
  stopping: 'Stopping',
  finishing: 'Finishing',
  succeeded: 'Succeeded',
  finished_with_unresolved: 'Finished, not everything confirmed',
  stopped: 'Stopped',
  failed: 'Failed',
}

export const isRunOver = (status: OrchestrationDetail['status']): boolean =>
  ['succeeded', 'finished_with_unresolved', 'stopped', 'failed'].includes(status)

export const usd = (value: number | null): string =>
  value === null ? 'unknown' : `$${value.toFixed(value < 1 ? 3 : 2)}`

/** Why a coding agent can't take a step, in everyday words, when the server gave no sentence of its own. */
export const readinessText: Record<WorkerReadiness, string> = {
  ready: 'Ready.',
  not_installed: 'Its program isn’t installed on this computer.',
  version_untested: 'Score hasn’t tested this version of its program yet.',
  level_unverified: 'Score can’t confirm how much it is allowed to do.',
  reach_unverifiable: 'Score can’t tell what it would be able to read.',
  changed: 'It changed since this run was approved.',
  paused: 'Coding agents are paused right now.',
  frozen: 'Score is holding all agent work until you review it on Now.',
  needs_units:
    'Score runs coding agents as separate system services, and this computer isn’t set up for that.',
}

/**
 * An orchestration's `coding` block in the shape the shared coding cards read (its limit is called `stepLimit` there;
 * a workflow calls it `codingSteps`).
 */
export function orchCoding(
  coding: OrchestrationDetail['coding'],
  quotaFloorPercent?: number | null,
): RunCoding | undefined {
  return coding
    ? {
        workers: coding.workers,
        codingSteps: coding.stepLimit,
        acceptedUnknownCost: coding.acceptedUnknownCost,
        quotaFloorPercent: quotaFloorPercent ?? null,
      }
    : undefined
}
