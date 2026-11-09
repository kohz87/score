import type { AgentSubagents, Job, SubagentRow } from '@score/contract'
import {
  subagentAtOnceText,
  subagentCostText,
  subagentCounts,
  subagentRowState,
} from '../subagents/subagent-model.ts'

// SA.3 part 8 (docs/design/bold/mockups/24-subagents-jobmap.dc.html): the job map's SUBAGENTS layer, one node for the
// lead's own helpers. A pure summary: no React, no DOM.

export interface SubagentLayerRow {
  id: string
  state: 'Done' | 'Waiting' | 'Failed' | 'Working'
  goal: string
  /** "12 s · about $0.02", "needs you · —": the time when it ended, then the cost (never $0 for unknown). */
  meta: string
}

export interface SubagentLayerModel {
  /** "4 subagents, 3 done". */
  title: string
  /** "lead’s own helpers · up to 4 at once". */
  detail: string
  /** "6 of 20 subagents used", the map's header line. */
  headerLine: string
  atOnce: string
  thisJob: string
  cost: string
  rows: SubagentLayerRow[]
  /** Some subagent is running now, so the line into the layer carries a moving dot. */
  working: boolean
}

const durationText = (row: SubagentRow): string | null => {
  if (!row.endedAt) return null
  const seconds = Math.max(
    0,
    Math.round((Date.parse(row.endedAt) - Date.parse(row.startedAt)) / 1000),
  )
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`
}

/** One row's facts: its time once it ended, a plain word while it waits or runs, and its cost. */
export function subagentLayerRow(row: SubagentRow): SubagentLayerRow {
  const state = subagentRowState(row)
  const when =
    durationText(row) ??
    (state === 'Waiting' ? 'needs you' : state === 'Working' ? 'working' : null)
  return {
    id: row.id,
    state,
    goal: row.goal,
    meta: [when, subagentCostText([row])].filter(Boolean).join(' · '),
  }
}

/**
 * The layer for a job's rows, or null when there are none (the node is shown only with rows). `ceiling` is the lead's
 * own settings when they are loaded; without them the job's limit reads as the agent's own.
 */
export function buildSubagentLayer(
  job: Pick<Job, 'subagents'>,
  rows: readonly SubagentRow[],
  ceiling: Pick<AgentSubagents, 'maxConcurrent'> | undefined,
  leadName: string,
): SubagentLayerModel | null {
  if (rows.length === 0) return null
  const counts = subagentCounts(rows)
  const atOnce = subagentAtOnceText(job, ceiling)
  const used = job.subagents?.used ?? rows.length
  const maxTotal = job.subagents?.maxTotal ?? null
  const thisJob = maxTotal === null ? String(used) : `${used} of ${maxTotal}`
  const plural = counts.total === 1 ? 'subagent' : 'subagents'
  const pace = atOnce === 'on' || atOnce === 'off' ? atOnce : `${atOnce} at once`
  return {
    title: `${counts.total} ${plural}, ${counts.done} done`,
    detail: `${leadName}’s own helpers · ${pace}`,
    headerLine: `${thisJob} subagents used`,
    atOnce,
    thisJob,
    cost: subagentCostText(rows),
    rows: rows.map(subagentLayerRow),
    working: counts.running > 0,
  }
}
