import type { Job, Message } from '@score/contract'
import { useStreamQuery } from '../../data/query-client.ts'
import { approvalsQuery } from '../../routes/chat/queries.ts'
import { orchestrationsQuery, useFence } from '../../routes/orchestrations/orchestration-queries.ts'
import { workflowRunsQuery } from '../../routes/workflows/workflow-queries.ts'
import { approvalInRoom, approvalNeedsYou, needsYou, reportBackWaiting } from './room-model.ts'
import { roomExchangesQuery, teamRoomQuery } from './room-queries.ts'
import { orchestrationNeedEntries, workflowNeedEntries } from './RunSafetyRequests.tsx'
import { blockedTask, roomTasksQuery } from './task-queries.ts'

/** The one Needs-you total for a room, plus whether every source has answered its first read. */
export function useRoomNeedsYouState({
  roomId,
  jobs,
  messages = [],
  selectedJob = 'all',
  teamRoom,
}: {
  roomId: string | null
  jobs: Job[]
  messages?: Message[]
  selectedJob?: string
  /** The team room also shows blocked tasks that belong to no room; the phone badge infers it from the room read. */
  teamRoom?: boolean
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
    (job) => job.state !== 'closed' && (selectedJob === 'all' || job.id === selectedJob),
  )
  const cooking = selectedJobs.filter(
    (job) => job.state === 'waiting_on_you' || job.state === 'working',
  )
  // The ids are the query's identity; a new job array with the same ids must not re-register it.
  const exchangeIds = cooking.map((job) => job.id).join('\u0000')
  const exchangesState = useStreamQuery(
    roomExchangesQuery(exchangeIds ? exchangeIds.split('\u0000') : []),
  )
  // Blocked Hermes tasks and report-backs are cards in the strip, so the total counts them too. The strip asks for the
  // same tasks read, so the two share one registration.
  const tasksState = useStreamQuery(
    roomTasksQuery(effectiveRoomId ?? '', teamRoom ?? canonical.data?.room.role === 'team', true),
  )
  const orchestrationsState = useStreamQuery(orchestrationsQuery)
  const workflowsState = useStreamQuery(workflowRunsQuery)
  const blockedTasks = (tasksState.data?.tasks ?? []).filter(blockedTask)
  const reportBackCount = reportBackWaiting(effectiveJobs).length
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
    /** Jobs with an exchange waiting on the person (the fold keeps these open). */
    waitingJobIds: new Set(exchanges.filter(needsYou).map((exchange) => exchange.jobId)),
    total:
      approvalCount +
      exchangeCount +
      runCount +
      reportBackCount +
      blockedTasks.length +
      (fence?.fenced ? 1 : 0),
    // The strip must not announce cards that were already there when it opened. A pending or failed read is not a
    // stable baseline, so announcements wait until every source has produced a snapshot.
    ready:
      approvalsState.status === 'success' &&
      exchangesState.status === 'success' &&
      orchestrationsState.status === 'success' &&
      workflowsState.status === 'success' &&
      tasksState.status === 'success' &&
      (roomId !== null || canonical.status === 'success'),
    // A source that failed counts as nothing above, so the total may be short: say so rather than a confident number.
    incomplete: [
      approvalsState,
      exchangesState,
      orchestrationsState,
      workflowsState,
      tasksState,
    ].some((read) => read.status === 'error'),
  }
}
