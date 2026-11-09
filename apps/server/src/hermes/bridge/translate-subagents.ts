import type { DatabaseSync } from 'node:sqlite'
import { endSubagentRow, startSubagent } from '../../domain/subagent-rows.ts'
import { jobOfSession } from '../../domain/subagents.ts'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { SubagentStartSchema, SubagentStopSchema } from './translate-schemas.ts'

/** A started subagent counts against its job and gets a row; a stopped one's row closes. Others' sessions are skipped. */
export function applySubagentHook(
  sqlite: DatabaseSync,
  hook: 'subagent_start' | 'subagent_stop',
  payload: unknown,
  producer: { profile: string },
  now: string,
): DomainEventDraft[] {
  if (hook === 'subagent_stop') {
    const stopped = SubagentStopSchema.safeParse(payload).data
    const child = stopped?.child_root_session_id ?? stopped?.child_session_id
    if (!child) return []
    const ok = stopped?.child_status === 'completed' || stopped?.child_status === 'success'
    return endSubagentRow(sqlite, child, ok ? 'done' : 'failed', now)
  }
  const started = SubagentStartSchema.safeParse(payload).data
  const parent = started?.policy_session_id ?? started?.parent_session_id
  if (!started?.child_session_id || !parent) return []
  const jobId = jobOfSession(sqlite, parent)
  if (!jobId) return []
  return startSubagent(sqlite, {
    id: started.child_session_id,
    jobId,
    profile: producer.profile,
    goal: started.child_goal ?? '',
    now,
  })
}
