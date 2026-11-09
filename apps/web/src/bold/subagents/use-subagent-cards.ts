import type { Job, Message, SubagentRow } from '@score/contract'
import { useMemo } from 'react'
import { attachSubagentRows } from './subagent-model.ts'
import { useRoomSubagentRows } from './subagent-queries.ts'

/**
 * The room's subagent rows, grouped under the message that started them (SA.3 part 2). Only jobs that carry limits are read:
 * a job without them has no subagents to show.
 */
export function useSubagentCards(jobs: Job[], messages: Message[]): Map<string, SubagentRow[]> {
  const jobIds = useMemo(() => jobs.filter((job) => job.subagents).map((job) => job.id), [jobs])
  const rows = useRoomSubagentRows(jobIds)
  return useMemo(() => attachSubagentRows(rows, messages), [messages, rows])
}
