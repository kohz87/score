import type { AgentSummary, Room } from '@score/contract'
import { useMemo } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { useStreamQuery } from '../../data/query-client.ts'
import { StatusLine } from '../../live/StatusLine.tsx'
import { useStatusLines } from '../../live/use-activity.ts'
import { approvalsQuery, messagesQuery } from './queries.ts'

type Mood = 'think' | 'work' | 'needs'
const words: Record<Mood, string> = {
  think: 'Thinking…',
  work: 'Working…',
  needs: 'Waiting for you',
}

/**
 * The members of the room that are busy, each with what it is doing. Resting and paused members are left out. The line
 * keeps its height when empty.
 */
export function RoomStatus({ room, agents }: { room: Room; agents: AgentSummary[] }) {
  const thread = useStreamQuery(useMemo(() => messagesQuery(room.id), [room.id])).data
  const approvals = useStreamQuery(approvalsQuery).data
  const people = useMemo(() => {
    const ids = [...room.members]
    if (room.leadAgentId && !ids.includes(room.leadAgentId)) ids.push(room.leadAgentId)
    return [...new Set(ids)].flatMap((id) => {
      const agent = agents.find((item) => item.id === id)
      return agent && agent.lifecycle?.state !== 'removed' ? [agent] : []
    })
  }, [room.members, room.leadAgentId, agents])
  const busy = useMemo(() => {
    const messages = thread?.items ?? []
    const needs = new Set(
      (approvals ?? [])
        .filter(
          (approval) =>
            approval.actionable &&
            approval.status === 'pending' &&
            (approval.refs.some((ref) => ref.kind === 'room' && ref.roomId === room.id) ||
              !approval.refs.some((ref) => ref.kind === 'room')),
        )
        .map((approval) => approval.agentId),
    )
    return people.flatMap<{ agent: AgentSummary; mood: Mood }>((agent) => {
      if (agent.status === 'paused' || agent.status === 'offline') return []
      if (needs.has(agent.id) && room.activeAgents.includes(agent.id))
        return [{ agent, mood: 'needs' as const }]
      const streaming = messages.filter(
        (message) =>
          message.streaming &&
          message.author.kind === 'agent' &&
          message.author.agentId === agent.id,
      )
      const typing = thread?.typing[agent.id]
      const hasContent = streaming.some((message) =>
        message.parts.some((part) =>
          part.kind === 'text' ? part.text.trim() !== '' : part.kind !== 'thinking',
        ),
      )
      if (hasContent || (typing !== undefined && typing !== ''))
        return [{ agent, mood: 'work' as const }]
      if (streaming.length > 0 || typing !== undefined) return [{ agent, mood: 'think' as const }]
      return []
    })
  }, [approvals, people, room.activeAgents, room.id, thread])
  const lines = useStatusLines(
    busy
      .filter(({ mood }) => mood === 'work')
      .map(({ agent }) => ({ id: agent.id, working: true })),
  )
  return (
    <ul className="chat-room-status" aria-label="Working now">
      {busy.slice(0, 3).map(({ agent, mood }) => (
        <li key={agent.id}>
          <AgentGlyph agent={agent} size="xs" bare decorative />
          <strong>{agent.name}</strong>
          <StatusLine
            line={mood === 'work' ? (lines.get(agent.id) ?? words.work) : words[mood]}
            reserve={false}
          />
        </li>
      ))}
      {busy.length > 3 && <li>and {busy.length - 3} more</li>}
    </ul>
  )
}
