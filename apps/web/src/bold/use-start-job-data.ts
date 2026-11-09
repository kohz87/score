import { CodingAgentsResponseSchema, type AgentSummary } from '@score/contract'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { apiFetch } from '../data/api.ts'
import { useStreamQuery } from '../data/query-client.ts'
import { agentsQuery, roomsQuery } from '../routes/chat/queries.ts'
import { fetchRoutines, routinesKey } from '../routes/team/routine-queries.ts'
import { usePreflight } from '../routes/orchestrations/orchestration-queries.ts'
import {
  useWorkflow,
  useWorkflowPreflight,
  useWorkflows,
} from '../routes/workflows/workflow-queries.ts'
import { activeJobs, isEveryoneRoom } from './room/room-model.ts'
import { roomJobsQuery, teamRoomQuery, teamRoomsQuery } from './room/room-queries.ts'
import { checkOf } from './start-job-checks.ts'
import { useAgentSubagents } from './subagents/subagent-queries.ts'
import type { StartJobOptions } from './start-job-types.ts'
import type { StartJobState } from './use-start-job-state.ts'

const NO_AGENTS: AgentSummary[] = []

export function useStartJobData(
  state: StartJobState,
  options: StartJobOptions | undefined,
  location: { search: string },
) {
  const {
    advisorPick,
    allowed,
    chatPick,
    leftRoomId,
    planner,
    recipe,
    setAdvisorPick,
    setVoterPick,
    voterPick,
  } = state
  const allAgents = useStreamQuery(agentsQuery).data ?? NO_AGENTS
  // Only agents that can take work: one still being set up, being deleted or removed is never offered (as in Add agent).
  const agents = useMemo(
    () => allAgents.filter((agent) => !agent.lifecycle || agent.lifecycle.state === 'ready'),
    [allAgents],
  )
  const workflows = useWorkflows()
  // The same stream-kept read of the team room as the room and Results (one cache entry, one reducer).
  const teamRoomState = useStreamQuery(teamRoomQuery(null))
  // 3.4.0: a job starts in the team room that is open (`?room=` names a team the person made), else the first one.
  const teamRoomsState = useStreamQuery(teamRoomsQuery)
  const openRoomId = new URLSearchParams(location.search).get('room')
  const chosenTeam = openRoomId
    ? teamRoomsState.data?.find((item) => item.id === openRoomId && !isEveryoneRoom(item))
    : undefined
  // 3.23.0: a chat that asks (its button, `/run`) names its room: a team or a group chat. A direct chat holds no run.
  const allRoomsState = useStreamQuery(roomsQuery)
  const allRooms = allRoomsState.data
  const askedFound = options?.roomId
    ? [...(teamRoomsState.data ?? []), ...(allRooms?.rooms ?? [])].find(
        (item) => item.id === options.roomId,
      )
    : undefined
  const askedRoom = askedFound && !askedFound.archived ? askedFound : null
  const askedArchived = Boolean(askedFound?.archived)
  const askedDirect =
    options?.roomId !== undefined &&
    askedFound === undefined &&
    (allRooms?.directs ?? []).some((item) => item.id === options.roomId)
  // A named chat that is archived or unknown never falls back to the team room: the run would start in the wrong place.
  const askedLoading =
    options?.roomId !== undefined &&
    askedFound === undefined &&
    !askedDirect &&
    (allRoomsState.status === 'pending' || teamRoomsState.status === 'pending')
  const askedMissing =
    options?.roomId !== undefined && askedFound === undefined && !askedDirect && !askedLoading
  const askedBlocked = askedArchived || askedMissing || askedLoading
  const chatChoices = [...(teamRoomsState.data ?? []), ...(allRooms?.rooms ?? [])].filter(
    (item, index, all) =>
      !item.archived &&
      item.id !== leftRoomId &&
      all.findIndex((other) => other.id === item.id) === index,
  )
  const defaultRoom = askedBlocked
    ? null
    : (askedRoom ?? chosenTeam ?? teamRoomState.data?.room ?? null)
  const startRoom =
    chatPick === null ? defaultRoom : (chatChoices.find((item) => item.id === chatPick) ?? null)
  // The room's jobs: one job per chat, so a start into a chat that is busy asks first.
  const startRoomJobs = useStreamQuery(roomJobsQuery(startRoom?.id ?? null)).data
  const runningJob = activeJobs(startRoomJobs ?? [])[0] ?? null
  const teamRoom = {
    data: teamRoomState.data,
    isPending: teamRoomState.status === 'pending',
    isError: teamRoomState.status === 'error',
  }

  const hermesAgents = agents.filter((agent) => !agent.runtime || agent.runtime === 'hermes')
  const askedProblem =
    chatPick !== null
      ? null
      : askedDirect
        ? 'Runs start in a group chat.'
        : askedArchived
          ? 'This chat is archived; unarchive it to start a run here.'
          : askedMissing
            ? 'Couldn’t find that chat.'
            : null
  const roomCheck = askedProblem
    ? { key: 'team-room', status: 'fail' as const, text: askedProblem }
    : chatPick !== null
      ? startRoom
        ? { key: 'team-room', status: 'ok' as const, text: `The job opens in ${startRoom.name}` }
        : { key: 'team-room', status: 'fail' as const, text: 'Choose a chat to start this in' }
      : askedLoading
        ? { key: 'team-room', status: 'pending' as const, text: 'Checking the chat' }
        : checkOf(teamRoom)
  const roomProblem =
    askedProblem ??
    (chatPick !== null ? 'Choose a chat to start this in.' : 'The team room is not ready yet.')
  const teamLead = startRoom?.leadAgentId ?? null
  // "Lead decides" needs a Hermes planner (decision 60). A room led by a coding agent (3.7.5) lets the person choose one.
  const leadIsCoding = Boolean(teamLead) && !hermesAgents.some((agent) => agent.id === teamLead)
  const leadId =
    (teamLead && !leadIsCoding
      ? teamLead
      : planner && hermesAgents.some((agent) => agent.id === planner)
        ? planner
        : hermesAgents[0]?.id) ?? ''
  // A pick that became the lead is dropped for good, so it doesn't come back when the lead changes again.
  const [seenLead, setSeenLead] = useState(leadId)
  if (seenLead !== leadId) {
    setSeenLead(leadId)
    if (advisorPick === leadId) setAdvisorPick('')
    if (voterPick.includes(leadId)) setVoterPick(voterPick.filter((id) => id !== leadId))
  }
  const roomLeadName = teamLead
    ? (agents.find((agent) => agent.id === teamLead)?.name ?? teamLead)
    : null
  const defaultAllowed = agents.filter((agent) => agent.id !== leadId).map((agent) => agent.id)
  // The planner is never also a step's agent, even after the person changed who plans (3.7.5 review).
  const allowedFor = (allowed ?? defaultAllowed).filter((id) => id !== leadId)
  const leadAgent = agents.find((agent) => agent.id === leadId)

  const selectedWorkflowId = recipe.kind === 'workflow' ? recipe.id : undefined
  const workflow = useWorkflow(selectedWorkflowId)
  const workflowDefinition = workflow.data?.latest.definition
  const workflowVersion = workflow.data?.latestVersion
  const workflowPreflight = useWorkflowPreflight(selectedWorkflowId, workflowVersion)
  const advisorId =
    advisorPick !== '' && advisorPick !== leadId && agents.some((agent) => agent.id === advisorPick)
      ? advisorPick
      : ''
  const voterIds = voterPick.filter(
    (id) => id !== leadId && agents.some((agent) => agent.id === id),
  )
  // The advisor and the voters run as steps, so the preflight checks them like allowed agents (policy and reach included).
  const preflightAgents = [
    ...allowedFor,
    ...(advisorId !== '' ? [advisorId] : []),
    ...voterIds,
  ].filter((id, index, all) => all.indexOf(id) === index)
  const orchestrationPreflight = usePreflight(leadId, preflightAgents)
  const codingAgents = useQuery({
    queryKey: ['coding', 'agents'],
    queryFn: async ({ signal }) =>
      CodingAgentsResponseSchema.parse(await apiFetch('coding-agents', { signal })).items,
    retry: false,
  })
  const codingWorkspace = (codingAgents.data ?? []).find((item) =>
    allowedFor.includes(item.id),
  )?.workspace
  const checkFolderNow = state.checkFolder ?? codingWorkspace ?? ''
  const autoVoteKNumber = Number(state.autoVoteK)
  // Under "approve every step" the votes are you, so Score doesn't vote first. Without voters there is nothing to vote.
  const autoVoteBlocked = state.ask === 'plan'
  const autoVoteOn = state.autoVote && !autoVoteBlocked && voterIds.length > 0
  // SA.3: the lead's settings decide what subagents Score can offer (the job's limits only narrow them).
  const leadSubagents = useAgentSubagents(leadId || null)

  const routineQueries = useQueries({
    queries: agents.map((agent) => ({
      queryKey: routinesKey(agent.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchRoutines(agent.id, signal),
      retry: false,
    })),
  })
  const scheduled = routineQueries.flatMap((query, index) => {
    const agentId = agents[index]?.id
    return agentId ? (query.data ?? []).map((routine) => ({ ...routine, agentId })) : []
  })

  return {
    agents,
    hermesAgents,
    workflows,
    chatChoices,
    startRoom,
    runningJob,
    roomCheck,
    roomProblem,
    teamLead,
    leadIsCoding,
    leadId,
    roomLeadName,
    allowedFor,
    leadAgent,
    workflow,
    workflowDefinition,
    workflowVersion,
    workflowPreflight,
    advisorId,
    voterIds,
    orchestrationPreflight,
    codingWorkspace,
    checkFolderNow,
    autoVoteKNumber,
    autoVoteBlocked,
    autoVoteOn,
    leadSubagents,
    scheduled,
  }
}

export type StartJobData = ReturnType<typeof useStartJobData>
