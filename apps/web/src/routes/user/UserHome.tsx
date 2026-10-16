import type { AgentSummary } from '@score/contract'
import { useRef, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { useStreamQuery } from '../../data/query-client.ts'
import { Composer } from '../chat/Composer.tsx'
import { saveDraft } from '../chat/composer-model.ts'
import { agentsQuery, roomsQuery } from '../chat/queries.ts'
import { useStartOrchestration } from './use-start-orchestration.tsx'
import { readLastRoom, userRoomPath } from './user-view.ts'

const hermesFirst = (agents: AgentSummary[]) =>
  [...agents].sort(
    (a, b) =>
      Number(Boolean(a.runtime && a.runtime !== 'hermes')) -
      Number(Boolean(b.runtime && b.runtime !== 'hermes')),
  )

/**
 * `/u`: opens the room you were last in, or (for New chat, or when there is none) the empty state: pick who to ask,
 * write the first message, and its room opens when it is sent.
 */
export function UserHome() {
  const location = useLocation()
  const fresh = (location.state as { fresh?: boolean } | null)?.fresh === true
  const rooms = useStreamQuery(roomsQuery)
  const agents = hermesFirst(useStreamQuery(agentsQuery).data ?? [])
  const navigate = useNavigate()
  const [picked, setPicked] = useState<string | null>(null)
  // A suggestion fills the draft, so the composer is made again to read it.
  const [round, setRound] = useState(0)
  const area = useRef<HTMLElement>(null)
  const starter = useStartOrchestration(agents)
  const last = readLastRoom()
  const all = [...(rooms.data?.rooms ?? []), ...(rooms.data?.directs ?? [])]
  if (!fresh && last && all.some((room) => room.id === last))
    return <Navigate to={userRoomPath(last)} replace />
  const directs = rooms.data?.directs ?? []
  const agentId =
    picked ?? agents.find((agent) => directs.some((r) => r.leadAgentId === agent.id))?.id ?? null
  const agent = agents.find((item) => item.id === agentId)
  const direct = directs.find((room) => room.leadAgentId === agentId)
  const askable = agents.filter((item) => directs.some((room) => room.leadAgentId === item.id))
  const lead = askable.find((item) => item.id === 'lead') ?? askable[0]
  const suggest = (text: string) => {
    const target = directs.find((room) => room.leadAgentId === lead?.id)
    if (!lead || !target) return
    setPicked(lead.id)
    saveDraft(target.id, text)
    setRound((value) => value + 1)
    requestAnimationFrame(() => area.current?.querySelector('textarea')?.focus())
  }
  return (
    <section className="user-empty" aria-label="New chat" ref={area}>
      <h1>What would you like to work on?</h1>
      <div role="radiogroup" aria-label="Ask" className="user-agents">
        {askable.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={item.id === agentId}
            className="user-agent"
            onClick={() => setPicked(item.id)}
          >
            <AgentGlyph agent={item} size="xs" bare decorative />
            {item.name}
          </button>
        ))}
      </div>
      {direct && agent ? (
        <Composer
          key={`${direct.id}:${round}`}
          roomId={direct.id}
          roomName={agent.name}
          agents={agents}
          leadAgentId={agent.id}
          onSent={() => void navigate(userRoomPath(direct.id))}
          orchestrate={starter.start}
        />
      ) : (
        <p className="user-muted" role="status">
          {rooms.data ? 'Add an agent in the admin view to start chatting.' : 'Loading…'}
        </p>
      )}
      {lead && (
        <ul className="user-chips" aria-label="Suggestions">
          <li>
            <button type="button" onClick={() => suggest('')}>
              Ask {lead.name}…
            </button>
          </li>
          <li>
            <button type="button" onClick={() => suggest('What is everyone working on right now?')}>
              Catch me up on the team
            </button>
          </li>
          <li>
            <button type="button" onClick={() => starter.start('')}>
              Start an orchestration…
            </button>
          </li>
        </ul>
      )}
      {starter.dialog}
    </section>
  )
}
