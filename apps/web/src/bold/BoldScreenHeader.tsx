import type { AgentSummary, WatchMarker } from '@score/contract'
import { Link } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { agentDisplayName, agentMood, agentStateLabel } from './bold-agents.ts'

export function BoldScreenHeader({
  agent,
  paused,
  pause,
  from,
  markers,
  gaps,
}: {
  agent: AgentSummary
  paused: boolean
  pause: { pending: boolean; failed: boolean; onToggle: () => void } | undefined
  from: number | null
  markers: WatchMarker[]
  gaps: number
}) {
  return (
    <>
      <div className="pagehead bold-screen-head">
        <Link className="link" to="/b">
          Team room
        </Link>
        <span className="muted">/</span>
        <AgentGlyph agent={agent} size="lg" decorative mood={agentMood(agent)} />
        <div className="bold-screen-title">
          <h1 id="bold-screen-title">{agentDisplayName(agent)}’s screen</h1>
          <span className="muted">{agentStateLabel(agent)}</span>
        </div>
        <div className="bold-screen-actions">
          {pause && (
            <button
              type="button"
              className="btn ghost"
              disabled={pause.pending}
              onClick={pause.onToggle}
            >
              {paused ? 'Resume' : 'Pause'} {agentDisplayName(agent)}
            </button>
          )}
          <Link className="btn ghost bold-screen-terminal" to="/terminal">
            Open in terminal
          </Link>
        </div>
      </div>
      {pause?.failed && (
        <p className="bold-screen-state" role="alert">
          Couldn’t {paused ? 'resume' : 'pause'} {agentDisplayName(agent)}. Try again.
        </p>
      )}
      {from !== null && markers.length > 0 && from < markers[0]!.seq && (
        <p className="bold-screen-state" role="status">
          That moment is older than the history Score keeps, so the replay starts at the earliest
          one available.
        </p>
      )}
      {gaps > 0 && (
        <p className="bold-screen-state" role="status">
          Score missed some events ({gaps} gap{gaps === 1 ? '' : 's'}), so this replay may have
          holes.
        </p>
      )}
    </>
  )
}
