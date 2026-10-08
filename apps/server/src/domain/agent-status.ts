import { AgentDetailSchema, AgentSummarySchema } from '@score/contract'
import { z } from 'zod'
import type { DeriveEvents } from '../hub/ingest.ts'
import { readAgent, storeAgent } from './agents.ts'

const ACTIVE = "('queued','running','waiting_for_approval')"

/**
 * An agent's status follows its runs. Runs are written by ingest without touching the agent projection, so the
 * status is derived here, in the same transaction as the run change, and announced as `agent.updated`.
 */
export const deriveAgentStatusEvents: DeriveEvents = (sqlite, drafts, { source }) => {
  if (source === 'fake') return []
  const agentIds = new Set<string>()
  for (const draft of drafts) if (draft.type === 'run.updated') agentIds.add(draft.data.agentId)
  const derived = []
  for (const agentId of agentIds) {
    const previous = readAgent(sqlite, agentId)
    // Offline, unserved and "up next" agents keep the state their own readers set.
    if (!previous || previous.status === 'offline' || previous.status === 'up-next') continue
    const rows = z
      .array(z.object({ status: z.string() }))
      .parse(
        sqlite
          .prepare(`SELECT status FROM runs WHERE profile = ? AND status IN ${ACTIVE}`)
          .all(agentId),
      )
    const status = rows.some((row) => row.status === 'waiting_for_approval')
      ? 'waiting'
      : rows.length
        ? 'working'
        : 'idle'
    const activity = rows.length ? 'Running a turn' : null
    if (previous.status === 'paused') continue // pause is its own state; it wins until resumed
    if (previous.status === status && previous.activity === activity) continue
    storeAgent(sqlite, AgentDetailSchema.parse({ ...previous, status, activity }))
    const stored = readAgent(sqlite, agentId)
    if (stored)
      derived.push({ type: 'agent.updated' as const, data: AgentSummarySchema.parse(stored) })
  }
  return derived
}
