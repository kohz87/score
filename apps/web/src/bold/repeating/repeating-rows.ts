import type { AgentSummary, RecipeSchedule, RepeatingJob } from '@score/contract'
import { routineModelText } from '../models/model-model.ts'
import { dayWords } from './schedule-words.ts'

// Tasks › Repeating (TR.2): one list for an agent's Hermes jobs and a recipe's schedules, in the order the page shows them.

export type Row = {
  key: string
  kind: 'job' | 'recipe'
  /** The job's id, or the recipe's workflow id. */
  id: string
  title: string
  what: string
  schedule: string
  nextRunAt: string | null
  agentId: string | null
  enabled: boolean
  /** The model cell: "its own · demo-model", "deep · pinned", or "per step" for a recipe. */
  model: string
  pinned: boolean
  /** The chat's name, or "Just the run". */
  results: string
  /** A recipe's last run when it did not start: missed or failed, in words. */
  problem: string | null
  job: RepeatingJob | null
}

export const NO_CHAT = 'Just the run'

export function jobRow(
  job: RepeatingJob,
  agents: readonly AgentSummary[],
  directIds: ReadonlySet<string> = new Set(),
): Row {
  const own = agents.find((agent) => agent.id === job.agentId)?.model?.id
  const text = routineModelText(job.model, own)
  return {
    key: `job:${job.id}`,
    kind: 'job',
    id: job.id,
    title: job.title,
    what: job.description,
    schedule: job.schedule,
    nextRunAt: job.nextRunAt,
    agentId: job.agentId,
    enabled: job.enabled,
    model: job.model ? `${text.model} · pinned` : text.model,
    pinned: Boolean(job.model),
    results: job.deliverTo
      ? directIds.has(job.deliverTo.roomId)
        ? `${job.deliverTo.roomName} (direct)`
        : job.deliverTo.roomName || NO_CHAT
      : NO_CHAT,
    problem: null,
    job,
  }
}

export function recipeRow(item: RecipeSchedule, now: Date): Row {
  const last = item.lastRun
  const when = last ? dayWords(new Date(last.at), now) : ''
  const problem =
    last?.outcome === 'missed'
      ? `Missed ${when}: Score wasn’t running. Run now starts it.`
      : last?.outcome === 'failed'
        ? `Failed ${when}: ${last.reason ?? 'Score couldn’t start it.'}`
        : null
  return {
    key: `recipe:${item.workflowId}`,
    kind: 'recipe',
    id: item.workflowId,
    title: item.recipeName,
    what: '',
    schedule: item.schedule,
    nextRunAt: item.nextRunAt,
    agentId: null,
    enabled: item.enabled,
    model: 'per step',
    pinned: false,
    results: item.roomName || NO_CHAT,
    problem,
    job: null,
  }
}

export type RowFilter = string | null

export const RECIPES_FILTER = '\u0000recipes'

export const filterRows = (rows: readonly Row[], filter: RowFilter) =>
  rows.filter(
    (row) =>
      filter === null ||
      (filter === RECIPES_FILTER ? row.kind === 'recipe' : row.agentId === filter),
  )

/** Agents that have jobs, in the order they first appear, with their counts. */
export function agentCounts(rows: readonly Row[]) {
  const counts = new Map<string, number>()
  for (const row of rows)
    if (row.agentId) counts.set(row.agentId, (counts.get(row.agentId) ?? 0) + 1)
  return [...counts]
}
