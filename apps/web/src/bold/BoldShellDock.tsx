import type { AgentSummary } from '@score/contract'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { agentDisplayName, agentMood, agentStateLabel, dockProgress } from './bold-agents.ts'

const DOCK_MAX = 7

/** The rings the dock draws: at most DOCK_MAX, those who need you first, and how many are left out. */
export function dockOverflow<T>(team: T[], needs: (item: T) => boolean) {
  if (team.length <= DOCK_MAX) return { shown: team, hidden: 0 }
  const room = DOCK_MAX - 1
  const urgent = team.filter(needs)
  const picked = new Set(urgent.slice(0, room))
  for (const item of team) {
    if (picked.size >= room) break
    picked.add(item)
  }
  // Keep the team's own order among the rings that stay.
  const shown = team.filter((item) => picked.has(item))
  return { shown, hidden: team.length - shown.length }
}

export function DockRing({
  agent,
  needsYou,
  onOpen,
}: {
  agent: AgentSummary
  needsYou: boolean
  onOpen: () => void
}) {
  const progress = dockProgress()
  const state = needsYou ? 'needs you' : agentStateLabel(agent)
  const name = agentDisplayName(agent)
  return (
    <button
      type="button"
      className={`ring ${needsYou ? 'needs bold-needs' : ''}`}
      // A ring that says "needs you" is a decision marker no theme may hide (PLAN 11.3, AGENTS.md design rules).
      data-protected={needsYou ? 'grid' : undefined}
      aria-label={`One to one with ${name}, ${state}`}
      title={`${name} · ${state}`}
      onClick={onOpen}
      data-progress={progress ?? undefined}
      style={{
        background:
          progress !== null
            ? `conic-gradient(${agent.style.color} 0 ${progress}%, var(--line) 0)`
            : 'var(--line)',
      }}
    >
      <span className="dock-ring-inner">
        <AgentGlyph
          agent={agent}
          size="sm"
          bare
          decorative
          mood={needsYou ? 'needs' : agentMood(agent)}
        />
      </span>
    </button>
  )
}
