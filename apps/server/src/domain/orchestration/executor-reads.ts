import {
  type OrchestrationEvents,
  type OrchestrationList,
  type OrchestrationSnapshot,
  type OrchestrationSummary,
} from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { HttpError } from '../../errors.ts'
import { headSeq } from '../../hub/snapshot.ts'
import { type GlobalFenceStore } from './fence.ts'
import { timelineOf } from './timeline.ts'
import { listLeadOrchs, requireOrch, type OrchRow } from './store.ts'
import { detailOf, summaryOf } from './views.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'

/** A lead-planned run; a workflow run id answers 404 here (its routes are /api/workflow-runs). */
export function requireLeadOrch(sqlite: DatabaseSync, id: string): OrchRow {
  const o = requireOrch(sqlite, id)
  if (o.planner !== 'lead')
    throw new HttpError(404, 'not_found', 'Couldn’t find that orchestration.')
  return o
}

export const readMethods = {
  // ------------------------------------------------------------------------------------------------------- reads

  list(this: OrchestratorRuntime): OrchestrationList {
    return this.db.read((sqlite) => ({
      asOfSeq: headSeq(sqlite),
      items: listLeadOrchs(sqlite).map((o) => summaryOf(sqlite, o)),
    }))
  },

  snapshot(this: OrchestratorRuntime, id: string): OrchestrationSnapshot {
    return this.db.read((sqlite) => ({
      asOfSeq: headSeq(sqlite),
      orchestration: detailOf(sqlite, requireLeadOrch(sqlite, id)),
    }))
  },

  /** Event history for the live diagram, log and replay (contract §14 "Events"). */
  events(this: OrchestratorRuntime, id: string): OrchestrationEvents {
    return this.db.read((sqlite) => ({
      asOfSeq: headSeq(sqlite),
      events: timelineOf(sqlite, requireLeadOrch(sqlite, id)),
    }))
  },

  summary(this: OrchestratorRuntime, id: string): OrchestrationSummary {
    return this.db.read((sqlite) => summaryOf(sqlite, requireLeadOrch(sqlite, id)))
  },

  /**
   * Journals a team or agent pause hold (or its lift) before the route changes the database, so a database that later
   * loses the hold is fenced. A journal that cannot be written fences admission at once (fail closed).
   */
  recordHold(
    this: OrchestratorRuntime,
    target: { kind: 'team' } | { kind: 'agent'; agentId: string },
    action: 'set' | 'lift',
  ): void {
    try {
      this.options.fence.journal.append({
        kind: 'hold',
        target: target.kind,
        ...(target.kind === 'agent' ? { agentId: target.agentId } : {}),
        action,
      })
    } catch (error) {
      this.fenceNow('journal_unwritable', error instanceof Error ? error.message : String(error))
    }
  },

  fenceStore(this: OrchestratorRuntime): GlobalFenceStore {
    return this.options.fence
  },
}

export type ReadMethods = typeof readMethods

export type ReadPublicMethods = Pick<
  ReadMethods,
  'list' | 'snapshot' | 'events' | 'summary' | 'recordHold' | 'fenceStore'
>
