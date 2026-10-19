import type { AgentSummary, Room } from '@score/contract'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { StatusLine } from '../../live/StatusLine.tsx'
import { useStatusLines } from '../../live/use-activity.ts'
import { useRoomMoods } from './stage/use-room-moods.ts'

const words = { think: 'Thinking…', needs: 'Waiting for you', work: 'Working…' } as const

/**
 * The members of the room that are busy, each with what it is doing: the same moods the room stage shows (it reads
 * them from one place), so the two never disagree. Resting and paused members are left out. The line keeps its
 * height when empty.
 */
export function RoomStatus({ room, agents }: { room: Room; agents: AgentSummary[] }) {
  const { people, moods } = useRoomMoods(room, agents)
  const busy = people.filter((agent) => {
    const mood = moods[agent.id]
    return mood === 'think' || mood === 'work' || mood === 'needs'
  })
  // A working agent says more than "Working…" when the live feed knows what it is doing (its tools).
  const lines = useStatusLines(
    busy
      .filter((agent) => moods[agent.id] === 'work')
      .map((agent) => ({ id: agent.id, working: true })),
  )
  return (
    <ul className="chat-room-status" aria-label="Working now">
      {busy.slice(0, 3).map((agent) => {
        const mood = moods[agent.id] as keyof typeof words
        return (
          <li key={agent.id}>
            <AgentGlyph agent={agent} size="xs" bare decorative />
            <strong>{agent.name}</strong>
            <StatusLine
              line={mood === 'work' ? (lines.get(agent.id) ?? words.work) : words[mood]}
              reserve={false}
            />
          </li>
        )
      })}
      {busy.length > 3 && <li>and {busy.length - 3} more</li>}
    </ul>
  )
}
