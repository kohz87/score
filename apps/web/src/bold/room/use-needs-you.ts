import type { Job, Message } from '@score/contract'
import { useStreamQuery } from '../../data/query-client.ts'
import { approvalsQuery } from '../../routes/chat/queries.ts'
import { orchestrationsQuery, useFence } from '../../routes/orchestrations/orchestration-queries.ts'
import { workflowRunsQuery } from '../../routes/workflows/workflow-queries.ts'
import { approvalInRoom, approvalNeedsYou, needsYou } from './room-model.ts'
import { roomExchangesQuery, teamRoomQuery } from './room-queries.ts'
import { orchestrationNeedEntries, workflowNeedEntries } from './RunSafetyRequests.tsx'

/** The one Needs-you total for a room, plus whether every source has answered its first read. */
export function useRoomNeedsYouState({
  roomId,
  jobs,
  messages = [],
  selectedJob = 'all',
}: {
  roomId: string | null
  jobs: Job[]
  messages?: Message[]
  selectedJob?: string
}) {
  // The shell's phone badge asks without a room: the canonical team-room read supplies the same room and jobs the
  // strip uses there, so the badge cannot count a different set of approvals or exchanges.
  const canonical = useStreamQuery(teamRoomQuery(null))
  const effectiveRoomId = roomId ?? canonical.data?.room.id ?? null
  const effectiveJobs = roomId === null && jobs.length === 0 ? (canonical.data?.jobs ?? []) : jobs
  const approvalsState = useStreamQuery(approvalsQuery)
  const approvals = approvalsState.data ?? []
  const fence = useFence().data
  const selectedJobs = effectiveJobs.filter(
    (job) => selectedJob === 'all' || job.id === selectedJob,
  )
  const cooking = selectedJobs.filter(
    (job) => job.state === 'waiting_on_you' || job.state === 'working',
  )
  // The ids are the query's identity; a new job array with the same ids must not re-register it.
  const exchangeIds = cooking.map((job) => job.id).join('\u0000')
  const exchangesState = useStreamQuery(
    roomExchangesQuery(exchangeIds ? exchangeIds.split('\u0000') : []),
  )
  const orchestrationsState = useStreamQuery(orchestrationsQuery)
  const workflowsState = useStreamQuery(workflowRunsQuery)
  const exchanges = exchangesState.data ?? []
  const orchestrations = orchestrationsState.data ?? []
  const workflows = workflowsState.data ?? []

  const approvalCount = approvals.filter((approval) => {
    if (!approvalNeedsYou(approval)) return false
    if (effectiveRoomId !== null && !approvalInRoom(approval, effectiveRoomId)) return false
    if (selectedJob === 'all') return true
    const message = messages.find((item) =>
      item.parts.some((part) => part.kind === 'approval' && part.approvalId === approval.id),
    )
    // The approvals read is complete; the message window is not. Match the strip's rule: only an approval whose
    // loaded message names a known other job is filtered out. An old message beyond the page gets no invented job.
    const known = effectiveJobs.find((job) => job.id === message?.jobId)
    return !known || known.id === selectedJob
  }).length

  const exchangeCount = exchanges.filter(needsYou).length
  const runCount = selectedJobs.reduce((count, job) => {
    if (job.recipe?.kind === 'orchestration') {
      const run = orchestrations.find((item) => item.id === job.recipe?.ref)
      return count + (run ? orchestrationNeedEntries(run).length : 0)
    }
    if (job.recipe?.kind === 'workflow') {
      const run = workflows.find((item) => item.id === job.recipe?.ref)
      return count + (run ? workflowNeedEntries(run).length : 0)
    }
    return count
  }, 0)

  return {
    total: approvalCount + exchangeCount + runCount + (fence?.fenced ? 1 : 0),
    // The strip must not announce cards that were already there when it opened. A pending or failed read is not a
    // stable baseline, so announcements wait until every source has produced a snapshot.
    ready:
      approvalsState.status === 'success' &&
      exchangesState.status === 'success' &&
      orchestrationsState.status === 'success' &&
      workflowsState.status === 'success' &&
      (roomId !== null || canonical.status === 'success'),
  }
}
