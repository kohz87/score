import type { AgentSummary, Message, Room } from '@score/contract'
import { useEffect, useMemo, useRef, useState } from 'react'
import { requestMention } from '../composer-mention.ts'
import { RoomStageView } from './RoomStageView.tsx'
import { newHandoff, type Handoff } from './stage-mood.ts'
import { useStageShown } from './stage-store.ts'
import { useQuiet } from './use-quiet.ts'
import { useRoomMoods } from './use-room-moods.ts'

/** How long two members that hand over face each other. */
export const HANDOFF_MS = 4000

/**
 * The room stage of one chat room (PLAN 10.10): reads what the room is doing from the live streams the thread already
 * uses (its messages and typing, the approvals) and hands it to the view as moods.
 */
export function RoomStage({ room, agents }: { room: Room; agents: AgentSummary[] }) {
  const shown = useStageShown()
  const roomId = room.id
  const { loaded, people, moods, messages, typing, approvals } = useRoomMoods(room, agents)
  const members = useMemo(
    () => people.map((agent) => ({ agent, mood: moods[agent.id] ?? ('rest' as const) })),
    [people, moods],
  )

  // Hand-offs: a reply that arrives after the stage opened is looked at until it completes, because its mention only
  // shows in later words (a reply opens empty). What was there when the room opened is not replayed.
  const seen = useRef<Set<string> | null>(null)
  const [handoff, setHandoff] = useState<Handoff | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!loaded) return
    if (seen.current === null) {
      seen.current = new Set(messages.map((message) => message.id))
      return
    }
    const found = newHandoff(
      messages,
      seen.current,
      people.map((agent) => agent.id),
    )
    // Done with a message once it turned out to be a hand-off, or has completed without being one.
    if (found) seen.current.add(found.id)
    for (const message of messages) if (!message.streaming) seen.current.add(message.id)
    if (!found) return
    setHandoff(found)
    // Not tied to this effect: the next streamed word must not cancel it.
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setHandoff(null), HANDOFF_MS)
  }, [loaded, messages, people])

  // Quiet: nothing new in the room (a message or a word of one, typing, an approval) for five minutes.
  const latest = messages.reduce<Message | undefined>(
    (best, message) => (!best || message.createdAt > best.createdAt ? message : best),
    undefined,
  )
  const signature = [
    messages.length,
    latest?.id,
    latest?.parts.reduce((total, part) => total + (part.kind === 'text' ? part.text.length : 1), 0),
    latest?.streaming,
    Object.entries(typing)
      .map(([id, text]) => `${id}:${text}`)
      .join(','),
    approvals
      .filter((approval) => approval.status === 'pending')
      .map((approval) => approval.id)
      .join(','),
  ].join('|')
  const quiet = useQuiet(signature)

  if (!shown || members.length === 0) return null
  return (
    <RoomStageView
      roomId={roomId}
      members={members}
      handoff={handoff}
      quiet={quiet}
      onMention={(agentId) => requestMention(roomId, agentId)}
    />
  )
}
