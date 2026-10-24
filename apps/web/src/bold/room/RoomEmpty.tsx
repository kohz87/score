import type { AgentSummary } from '@score/contract'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'

const STARTERS = [
  {
    id: 'build',
    title: 'Build something, reviewed',
    hint: 'builder makes it, reviewer checks it',
    text: 'Build a small feature and have reviewer check it.',
    agents: ['builder', 'reviewer'],
  },
  {
    id: 'research',
    title: 'Research and compare',
    hint: 'A short summary with sources',
    text: 'Research the options and give me a short summary with sources.',
    agents: ['lead'],
  },
  {
    id: 'write',
    title: 'Write and review a document',
    hint: 'Saved to the Library',
    text: 'Write a short document about the project, then have reviewer check it.',
    agents: ['lead', 'reviewer'],
  },
  {
    id: 'design',
    title: 'Design something',
    hint: 'Sketches first, then a final',
    text: 'Design a first sketch and bring it to a final.',
    agents: ['designer'],
  },
] as const

function GlyphStack({ agents, ids }: { agents: AgentSummary[]; ids: readonly string[] }) {
  const found = ids.flatMap((id) => agents.find((agent) => agent.id === id) ?? [])
  return (
    <span className="bold-starter-glyphs" aria-hidden="true">
      {found.map((agent) => (
        <AgentGlyph key={agent.id} agent={agent} size="xs" decorative />
      ))}
    </span>
  )
}

/** Board 09: the first thing a fresh team room shows before there is any job or message. */
export function RoomEmpty({
  agents,
  onStart,
}: {
  agents: AgentSummary[]
  onStart: (text: string) => void
}) {
  return (
    <div className="bold-empty-room">
      <div className="bold-empty-copy">
        <h2>Your team is ready. What first?</h2>
        <p>
          Describe it in plain words. lead splits it up and brings in whoever it needs. Each request
          becomes a job you can follow in its own tab.
        </p>
      </div>
      <div className="bold-starters">
        {STARTERS.map((starter) => (
          <button
            key={starter.id}
            type="button"
            className="bold-starter"
            onClick={() => onStart(starter.text)}
          >
            <GlyphStack agents={agents} ids={starter.agents} />
            <b>{starter.title}</b>
            <span>{starter.hint}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
