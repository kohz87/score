import type {
  AgentSummary,
  OrchEvent,
  OrchestrationDetail,
  StepView,
  VoteView,
} from '@score/contract'
import {
  isRunOver,
  stepVisual,
  visualLabel,
  type NodeVisual,
} from '../../routes/orchestrations/orch-model.ts'

// 3.15 (decision 151): the job map is a pure summary of one lead-decides job, one node per layer. No React, no DOM.

export type LayerId = 'you' | 'lead' | 'advisor' | 'votes' | 'swarm' | 'workers' | 'check'

export const LAYER_LABEL: Record<LayerId, string> = {
  you: 'You',
  lead: 'Lead',
  advisor: 'Advisor',
  votes: 'Fork layer',
  swarm: 'Swarm',
  workers: 'Workers',
  check: 'Check',
}

export type Tone = 'done' | 'run' | 'now' | 'off' | 'bad'

export interface Chip {
  stepId: string
  label: string
  visual: NodeVisual
  tone: Tone
}

export interface AskedAdvisor {
  count: number
  tokens: number
  questions: string[]
}

export interface WorkerNode {
  agentId: string
  name: string
  chips: Chip[]
  asked: AskedAdvisor | null
  running: boolean
}

export interface SwarmNode {
  agentId: string
  name: string
  role: string
  visual: NodeVisual
  tone: Tone
  lastSign: string | null
  running: boolean
}

export interface VoteRow {
  id: string
  question: string
  share: number
  status: VoteView['status']
  label: string
}

export interface AdvisorMark {
  key: 'before_plan' | 'repeat_failure' | 'before_done'
  label: string
  used: boolean
}

export interface LogLine {
  id: string
  at: string
  layer: LayerId
  text: string
}

export interface JobMapModel {
  goal: string
  lead: {
    agentId: string
    name: string
    turn: number
    maxTurns: number
    progress: string
    doing: string
    working: boolean
  }
  advisor: {
    agentId: string
    name: string
    mode: 'on_call' | 'checkpoints'
    marks: AdvisorMark[]
    consults: number
    tokens: number
    working: boolean
  } | null
  votes: { rows: VoteRow[]; voting: boolean } | null
  swarm: SwarmNode[] | null
  workers: WorkerNode[]
  check: {
    command: string
    outcome: string | null
    at: string | null
    tone: Tone
    running: boolean
  } | null
  layers: LayerId[]
  /** Layers where work flows right now (the lines into them carry moving dots). */
  active: Set<LayerId>
  log: LogLine[]
}

const STEP_TONE: Partial<Record<NodeVisual, Tone>> = {
  succeeded: 'done',
  running: 'run',
  admitting: 'run',
  gate: 'now',
  failed: 'bad',
  blocked: 'bad',
  rejected: 'bad',
  unknown: 'bad',
}
export const toneOf = (visual: NodeVisual): Tone => STEP_TONE[visual] ?? 'off'

const chipLabel = (stepId: string, visual: NodeVisual) =>
  visual === 'succeeded' ? `${stepId} ✓` : `${stepId} ${visualLabel[visual]}`

const MARKS: [AdvisorMark['key'], string][] = [
  ['before_plan', 'before plan'],
  ['repeat_failure', 'failure ×2'],
  ['before_done', 'before done'],
]

export const formatTokens = (n: number): string =>
  n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const attemptOf = (run: OrchestrationDetail, stepId: string) =>
  run.attempts.findLast((attempt) => attempt.stepId === stepId)
const visualOfStep = (run: OrchestrationDetail, step: StepView) =>
  stepVisual(step, attemptOf(run, step.id))

/** Ordered by first appearance. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item])
  return out
}

export function buildJobMap(
  run: OrchestrationDetail,
  events: readonly OrchEvent[],
  agents: readonly Pick<AgentSummary, 'id' | 'name'>[],
): JobMapModel {
  const nameOf = (id: string) => agents.find((agent) => agent.id === id)?.name || id
  const steps = run.stepsList
  const workerSteps = steps.filter((step) => !step.role)
  const helperSteps = steps.filter((step) => step.role === 'helper')
  const over = isRunOver(run.status)

  // --- lead
  const leadWorking =
    !over &&
    run.attempts.some(
      (attempt) =>
        attempt.kind === 'lead' && ['created', 'send_started', 'running'].includes(attempt.state),
    )
  const lastLead = events.findLast(
    (event) => event.kind === 'lead_wake' || event.kind === 'lead_done' || event.kind === 'command',
  )
  const done = workerSteps.filter((step) => step.status === 'succeeded').length
  const lead: JobMapModel['lead'] = {
    agentId: run.leadAgentId,
    name: nameOf(run.leadAgentId),
    turn: run.leadTurnsUsed,
    maxTurns: run.maxLeadTurns,
    progress: `${run.plan.length} plan ${run.plan.length === 1 ? 'line' : 'lines'} · ${done} of ${workerSteps.length} steps done`,
    doing: over
      ? 'finished'
      : (lastLead?.summary ?? (leadWorking ? 'working on the plan' : 'waiting for the steps')),
    working: leadWorking,
  }

  // --- what the workers asked the advisor
  const onCall = run.advisor?.onCall ?? []
  const askedBy = new Map<string, AskedAdvisor>()
  for (const entry of onCall) {
    const stepAgent = steps.find((step) => step.id === entry.stepId)?.agentId ?? entry.agentId
    const have = askedBy.get(stepAgent) ?? { count: 0, tokens: 0, questions: [] }
    askedBy.set(stepAgent, {
      count: have.count + 1,
      tokens: have.tokens + (entry.totalTokens ?? 0),
      questions: [...have.questions, entry.question],
    })
  }

  // --- advisor
  const advisor: JobMapModel['advisor'] = run.advisor
    ? {
        agentId: run.advisor.agentId,
        name: nameOf(run.advisor.agentId),
        mode: run.advisor.mode ?? 'checkpoints',
        marks: MARKS.map(([key, label]) => ({
          key,
          label,
          used: run.advisor!.consults.some((consult) => consult.checkpoint === key),
        })),
        consults: run.advisor.consults.length + onCall.length,
        tokens: onCall.reduce((sum, entry) => sum + (entry.totalTokens ?? 0), 0),
        working:
          !over &&
          (run.advisor.consults.some((c) => c.status === 'admitted') ||
            onCall.some((entry) => entry.status === 'running')),
      }
    : null

  // --- votes
  const allVotes = run.helpers?.votes ?? []
  const votes: JobMapModel['votes'] =
    allVotes.length > 0
      ? {
          rows: allVotes.slice(-3).map((vote) => ({
            id: vote.id,
            question: vote.question,
            share: vote.share ?? 0,
            status: vote.status,
            label: vote.status === 'failed' ? 'no answers' : vote.status,
          })),
          voting: allVotes.some((vote) => vote.status === 'voting'),
        }
      : null

  // --- swarm: one node per helper agent, from its latest helper step
  const swarm: JobMapModel['swarm'] = run.helpers
    ? [...groupBy(helperSteps, (step) => step.agentId)].map(([agentId, list]) => {
        const latest = list[list.length - 1] as StepView
        const visual = visualOfStep(run, latest)
        return {
          agentId,
          name: nameOf(agentId),
          role: latest.helperRole ?? 'helper',
          visual,
          tone: toneOf(visual),
          lastSign: latest.lastActivityAt ? clock(latest.lastActivityAt) : null,
          running: !over && visual === 'running',
        }
      })
    : null

  // --- workers
  const workers: WorkerNode[] = [...groupBy(workerSteps, (step) => step.agentId)].map(
    ([agentId, list]) => {
      const chips = list.map((step) => {
        const visual = visualOfStep(run, step)
        return { stepId: step.id, label: chipLabel(step.id, visual), visual, tone: toneOf(visual) }
      })
      return {
        agentId,
        name: nameOf(agentId),
        chips,
        asked: askedBy.get(agentId) ?? null,
        running: !over && chips.some((chip) => chip.visual === 'running'),
      }
    },
  )

  // --- check
  const latestRun = run.check?.runs[0]
  const checkTone: Tone = !latestRun
    ? 'off'
    : latestRun.outcome === 'passed'
      ? 'done'
      : latestRun.outcome === 'queued' || latestRun.outcome === 'running'
        ? 'run'
        : 'bad'
  const check: JobMapModel['check'] = run.check
    ? {
        command: run.check.command,
        outcome: latestRun?.outcome.replace('_', ' ') ?? null,
        at: latestRun
          ? clock(latestRun.endedAt ?? latestRun.startedAt ?? latestRun.queuedAt)
          : null,
        tone: checkTone,
        running: !over && checkTone === 'run',
      }
    : null

  const layers: LayerId[] = ['you', 'lead']
  if (advisor) layers.push('advisor')
  if (votes) layers.push('votes')
  if (swarm) layers.push('swarm')
  if (workers.length > 0) layers.push('workers')
  if (check) layers.push('check')

  const active = new Set<LayerId>()
  if (lead.working) active.add('lead')
  if (advisor?.working) active.add('advisor')
  if (votes?.voting) active.add('votes')
  if (swarm?.some((node) => node.running)) active.add('swarm')
  if (workers.some((node) => node.running)) active.add('workers')
  if (check?.running) active.add('check')

  return {
    goal: run.goal,
    lead,
    advisor,
    votes,
    swarm,
    workers,
    check,
    layers,
    active,
    log: buildLog(run, events, nameOf),
  }
}

// ------------------------------------------------------------------------------------------------------- the log

/** Which layer an event belongs to: by the step's kind, else the tool; run-level events belong to the lead. */
function layerOfEvent(event: OrchEvent, byId: Map<string, StepView>): LayerId {
  if (event.kind === 'command') {
    if (event.tool === 'orch.vote') return 'votes'
    if (event.tool === 'orch.check') return 'check'
    return 'lead'
  }
  const step = event.stepId ? byId.get(event.stepId) : undefined
  if (!step) return 'lead'
  if (step.role === 'advisor') return 'advisor'
  if (step.role === 'vote') return 'votes'
  if (step.role === 'helper') return 'swarm'
  return 'workers'
}

/** Every line of the job's story, oldest first (the view shows the newest few of the chosen layer). */
export function buildLog(
  run: OrchestrationDetail,
  events: readonly OrchEvent[],
  nameOf: (id: string) => string,
): LogLine[] {
  const byId = new Map(run.stepsList.map((step) => [step.id, step]))
  const lines: LogLine[] = events.map((event) => ({
    id: event.id,
    at: event.at,
    layer: layerOfEvent(event, byId),
    text: event.summary,
  }))
  // The workers' own asks are not in the orchestration events: they come from the advisor read.
  ;(run.advisor?.onCall ?? []).forEach((entry, index) => {
    const agent = byId.get(entry.stepId)?.agentId ?? entry.agentId
    lines.push({
      id: `oncall-${entry.stepId}-${index}`,
      at: entry.at,
      layer: 'advisor',
      text: `${nameOf(agent)} asked the advisor: ${entry.question}`,
    })
  })
  return lines.sort((a, b) => a.at.localeCompare(b.at))
}

/** The lines a click on a layer shows. `null` = everything; the phone has no advisor node, so the lead's covers both. */
export function logFor(
  model: Pick<JobMapModel, 'log'>,
  layer: LayerId | null,
  options: { phone?: boolean; limit?: number } = {},
): LogLine[] {
  const limit = options.limit ?? 8
  const wanted: LayerId[] | null =
    layer === null
      ? null
      : layer === 'you'
        ? ['lead']
        : layer === 'lead' && options.phone
          ? ['lead', 'advisor']
          : [layer]
  const lines = wanted ? model.log.filter((line) => wanted.includes(line.layer)) : model.log
  return lines.slice(-limit)
}
