import { useStreamQuery } from '../data/query-client.ts'
import { approvalsQuery } from '../routes/chat/queries.ts'

// True while any approval is waiting on a human; the stream query keeps it live on every screen.
export function useNeedsYou(): boolean {
  const approvals = useStreamQuery(approvalsQuery)
  return (approvals.data ?? []).some((item) => item.actionable && item.phase === 'human_pending')
}
