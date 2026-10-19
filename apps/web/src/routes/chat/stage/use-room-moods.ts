import type { AgentSummary, Approval, Message, Room } from '@score/contract'
import { useMemo } from 'react'
import { useStreamQuery } from '../../../data/query-client.ts'
import { approvalsQuery, messagesQuery } from '../queries.ts'
import { stageMembers, stageMoods, type StageMood } from './stage-mood.ts'

const NO_APPROVALS: Approval[] = []

export type RoomMoods = {
  /** False until the room's messages have loaded. */
  loaded: boolean
  people: AgentSummary[]
  moods: Record<string, StageMood>
  messages: Message[]
  typing: Record<string, string>
  approvals: Approval[]
}

/**
 * What each member of the room is doing, from the live state the thread already reads: the stage and the header
 * line both speak from here, so they never disagree.
 */
export function useRoomMoods(room: Room, agents: AgentSummary[]): RoomMoods {
  const roomId = room.id
  const definition = useMemo(() => messagesQuery(roomId), [roomId])
  const thread = useStreamQuery(definition).data
  const approvals = useStreamQuery(approvalsQuery).data ?? NO_APPROVALS
  const people = useMemo(
    () => stageMembers(room, agents),
    // Only what decides who is on the stage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room.members, room.leadAgentId, room.kind, agents],
  )
  const messages = useMemo(() => thread?.items ?? [], [thread?.items])
  const typing = useMemo(() => thread?.typing ?? {}, [thread?.typing])
  const moods = useMemo(
    () =>
      stageMoods({
        roomId,
        members: people,
        messages,
        typing,
        approvals,
        serverBusy: room.activeAgents,
      }),
    [roomId, people, messages, typing, approvals, room.activeAgents],
  )
  return { loaded: thread !== undefined, people, moods, messages, typing, approvals }
}
