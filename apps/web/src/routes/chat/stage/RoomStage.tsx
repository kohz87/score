import type { AgentSummary, Room } from '@score/contract'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStreamQuery } from '../../../data/query-client.ts'
import { requestMention } from '../composer-mention.ts'
import { approvalsQuery, messagesQuery } from '../queries.ts'
import { RoomStageView } from './RoomStageView.tsx'
import { newHandoff, stageMembers, stageMoods, type Handoff } from './stage-mood.ts'
import { useStageShown } from './stage-store.ts'

/** How long two members that hand over face each other. */
export const HANDOFF_MS = 4000

/**
 * The room stage of one chat room (PLAN 10.10): reads what the room is doing from the live streams the thread already
 * uses (its messages and typing, the room's active agents, the approvals) and hands it to the view as moods.
 */
export function RoomStage({ room, agents }: { room: Room; agents: AgentSummary[] }) {
  const shown = useStageShown()
  const roomId = room.id
  const definition = useMemo(() => messagesQuery(roomId), [roomId])
  const thread = useStreamQuery(definition).data
  const approvals = useStreamQuery(approvalsQuery).data
  const people = useMemo(
    () => stageMembers(room, agents),
    // Only what decides who is on the stage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room.members, room.leadAgentId, room.kind, agents],
  )
  const messages = useMemo(() => thread?.items ?? [], [thread?.items])
  const typing = thread?.typing
  const moods = useMemo(
    () =>
      stageMoods({
        roomId,
        members: people,
        messages,
        typing: typing ?? {},
        activeAgents: room.activeAgents,
        approvals: approvals ?? [],
      }),
    [roomId, people, messages, typing, room.activeAgents, approvals],
  )
  const members = useMemo(
    () => people.map((agent) => ({ agent, mood: moods[agent.id] ?? ('rest' as const) })),
    [people, moods],
  )

  // Hand-offs: only messages that arrive after the stage opened count; what was already there is not replayed.
  const seen = useRef<Set<string> | null>(null)
  const [handoff, setHandoff] = useState<Handoff | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!thread) return
    if (seen.current === null) {
      seen.current = new Set(messages.map((message) => message.id))
      return
    }
    const found = newHandoff(
      messages,
      seen.current,
      people.map((agent) => agent.id),
    )
    for (const message of messages) seen.current.add(message.id)
    if (!found) return
    setHandoff(found)
    // Not tied to this effect: the next streamed word must not cancel it.
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setHandoff(null), HANDOFF_MS)
  }, [thread, messages, people])

  if (!shown || members.length === 0) return null
  return (
    <RoomStageView
      roomId={roomId}
      members={members}
      handoff={handoff}
      onMention={(agentId) => requestMention(roomId, agentId)}
    />
  )
}
