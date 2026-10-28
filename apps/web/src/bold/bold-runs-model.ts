import type {
  OrchestrationDetail,
  OrchestrationSummary,
  WorkflowRunDetail,
  WorkflowRunSummary,
} from '@score/contract'
import {
  isRunOver,
  leadSteps,
  pauseReasonText,
  stepVisual,
  statusLabel,
  type NodeVisual,
} from '../routes/orchestrations/orch-model.ts'
import { nodeVisual } from '../routes/workflows/workflow-run-model.ts'

// The Runs side panel (decision 131, boards A and B): one list of every run, and a run as a thread of its steps.
// Pure; the server's snapshots are the only input.

export type RunKind = 'orchestration' | 'workflow'

export interface RunRow {
  kind: RunKind
  id: string
  briefId: string
  title: string
  /** The recipe or workflow a run came from; null for a lead-decides run. */
  source: string | null
  statusText: string
  over: boolean
  needs: number
  /** "3 of 5 steps done". */
  progress: string
  createdAt: string
}

export type RunFilter = 'all' | 'needs' | 'running' | 'done'

function orchestrationStatusText(run: OrchestrationSummary): string {
  return run.status === 'paused' ? pauseReasonText(run.pauseReason) : statusLabel[run.status]
}

export function runRows(
  orchestrations: readonly OrchestrationSummary[],
  workflows: readonly WorkflowRunSummary[],
): RunRow[] {
  const rows: RunRow[] = [
    ...orchestrations.map((run): RunRow => ({
      kind: 'orchestration',
      id: run.id,
      briefId: run.briefId,
      title: run.title,
      source: null,
      statusText: orchestrationStatusText(run),
      over: isRunOver(run.status),
      needs: run.needsYou.length,
      progress: `${run.steps.succeeded} of ${run.steps.total} steps done`,
      createdAt: run.createdAt,
    })),
    ...workflows.map((run): RunRow => ({
      kind: 'workflow',
      id: run.id,
      briefId: run.briefId,
      title: run.title,
      source: run.workflowName,
      statusText:
        run.status === 'paused' ? pauseReasonText(run.pauseReason) : statusLabel[run.status],
      over: isRunOver(run.status),
      needs: run.needsYou.length,
      progress: `${run.nodes.succeeded} of ${run.nodes.total} steps done`,
      createdAt: run.createdAt,
    })),
  ]
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
}

export function filterRuns(rows: readonly RunRow[], filter: RunFilter): RunRow[] {
  switch (filter) {
    case 'needs':
      return rows.filter((row) => row.needs > 0)
    case 'running':
      return rows.filter((row) => !row.over)
    case 'done':
      return rows.filter((row) => row.over)
    default:
      return [...rows]
  }
}

/** One entry of the thread. */
export interface ThreadStep {
  id: string
  n: number
  kind: 'lead' | 'agent' | 'advisor' | 'gate' | 'branch' | 'join' | 'end'
  agentId: string | null
  /** What the step is: the instruction, the node's label or the gate's question. */
  title: string
  visual: NodeVisual
  /** The agent's reply, when it gave one. */
  reply: string | null
  /** Why a step failed or waits, one line. */
  note: string | null
  tries: string | null
  waitsOnYou: boolean
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** Ids a needs-you item points at (a step of an orchestration or a node of a workflow). */
function waitingIds(items: readonly object[]): Set<string> {
  const ids = new Set<string>()
  for (const item of items) {
    const record = item as { stepId?: unknown; nodeId?: unknown; nodeIds?: unknown }
    if (typeof record.stepId === 'string') ids.add(record.stepId)
    if (typeof record.nodeId === 'string') ids.add(record.nodeId)
    if (Array.isArray(record.nodeIds))
      for (const id of record.nodeIds) if (typeof id === 'string') ids.add(id)
  }
  return ids
}

const checkpointText = {
  before_plan: 'before the plan',
  repeat_failure: 'same failure twice',
  before_done: 'before it finishes',
} as const

/** The lead's steps and the advisor's consults in the order they were created (consults are entries too and are numbered with the steps). */
function threadEntries(run: OrchestrationDetail): ThreadStep[] {
  const waiting = waitingIds(run.needsYou)
  const entries: { at: string; entry: ThreadStep }[] = leadSteps(run.stepsList).map((step) => {
    const attempts = run.attempts.filter((attempt) => attempt.stepId === step.id)
    const visual = stepVisual(step, attempts.at(-1))
    const failed = ['failed', 'blocked', 'rejected', 'cancelled'].includes(visual)
    return {
      at: step.createdAt,
      entry: {
        id: step.id,
        n: 0,
        kind: 'agent',
        agentId: step.agentId,
        title: clip(step.instruction, 160),
        visual,
        reply: step.result,
        note: failed ? (step.disposition ?? null) : null,
        tries: attempts.length > 1 ? `${attempts.length} tries` : null,
        waitsOnYou: waiting.has(step.id) || visual === 'gate',
      },
    }
  })
  const advisor = run.advisor
  if (advisor)
    for (const consult of advisor.consults) {
      const attempts = run.attempts.filter((attempt) => attempt.stepId === consult.stepId)
      const step = run.stepsList.find((item) => item.id === consult.stepId)
      entries.push({
        at: consult.createdAt,
        entry: {
          id: consult.stepId,
          n: 0,
          kind: 'advisor',
          agentId: advisor.agentId,
          title: `Advisor · ${checkpointText[consult.checkpoint]}`,
          visual: step ? stepVisual(step, attempts.at(-1)) : 'queued',
          reply: consult.advice,
          note: consult.reason !== '' ? consult.reason : null,
          tries: null,
          waitsOnYou: false,
        },
      })
    }
  return entries.sort((a, b) => a.at.localeCompare(b.at)).map((item) => item.entry)
}

export function orchestrationThread(run: OrchestrationDetail): ThreadStep[] {
  const steps: ThreadStep[] = [
    {
      id: 'lead',
      n: 1,
      kind: 'lead',
      agentId: run.leadAgentId,
      title: `Lead plans (turn ${run.leadTurnsUsed} of ${run.maxLeadTurns})`,
      visual: run.leadTurnsUsed > 0 ? 'succeeded' : 'queued',
      reply:
        run.plan.length > 0
          ? run.plan.map((line, index) => `${index + 1}. ${line}`).join('\n')
          : null,
      note: null,
      tries: null,
      waitsOnYou: false,
    },
    ...threadEntries(run),
  ]
  steps.forEach((entry, index) => {
    entry.n = index + 1
  })
  if (run.finish)
    steps.push({
      id: 'finish',
      n: steps.length + 1,
      kind: 'end',
      agentId: run.leadAgentId,
      title: `Finished: ${run.finish.outcome}`,
      visual: run.finish.outcome === 'failed' ? 'failed' : 'succeeded',
      reply: run.finish.summary,
      note: null,
      tries: null,
      waitsOnYou: false,
    })
  return steps
}

export function workflowThread(run: WorkflowRunDetail): ThreadStep[] {
  const waiting = waitingIds(run.needsYou)
  // The nodes that started come first, in start order; the ones not reached keep the definition's order after them.
  const states = new Map(run.nodeStates.map((state) => [state.nodeId, state]))
  const started = (id: string) => states.get(id)?.startedAt ?? null
  const ordered = [...run.definition.nodes].sort((a, b) => {
    const one = started(a.id)
    const two = started(b.id)
    if (one && two) return one.localeCompare(two)
    if (one) return -1
    if (two) return 1
    return 0
  })
  return ordered.map((node, index): ThreadStep => {
    const state = states.get(node.id)
    const agent = node.kind === 'agent'
    return {
      id: node.id,
      n: index + 1,
      kind: node.kind,
      agentId: agent ? node.agentId : null,
      title: node.kind === 'gate' ? `${node.label}: ${node.question}` : node.label,
      visual: state ? nodeVisual(state.state) : 'waiting',
      reply: state?.output ?? null,
      note: state?.reason ?? null,
      tries:
        agent && state && state.attemptsUsed > 1
          ? `${state.attemptsUsed} of ${state.attemptsMax} tries`
          : null,
      waitsOnYou: waiting.has(node.id) || state?.state === 'gate_open',
    }
  })
}
