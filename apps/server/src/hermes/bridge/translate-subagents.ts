import type { DatabaseSync } from 'node:sqlite'
import { endSubagentRow, startSubagentRow } from '../../domain/subagent-rows.ts'
import { countSubagentOfSession, jobOfSession } from '../../domain/subagents.ts'
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
    if (!stopped?.child_session_id) return []
    const ok = stopped.child_status === 'completed' || stopped.child_status === 'success'
    return endSubagentRow(sqlite, stopped.child_session_id, ok ? 'done' : 'failed', now)
  }
  const started = SubagentStartSchema.safeParse(payload).data
  if (!started?.parent_session_id) return []
  const jobId = jobOfSession(sqlite, started.parent_session_id)
  if (!jobId) return []
  return [
    ...countSubagentOfSession(sqlite, started.parent_session_id),
    ...(started.child_session_id
      ? startSubagentRow(sqlite, {
          id: started.child_session_id,
          jobId,
          profile: producer.profile,
          goal: started.child_goal ?? '',
          now,
        })
      : []),
  ]
}
