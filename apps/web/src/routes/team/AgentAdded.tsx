import type { AgentStyle } from '@score/contract'
import { Link } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'

/** The end of Add agent and Import agent: what joined, and where to go next (replaces the form, not added under it). */
export function AgentAdded({
  agent,
  detail,
  onAnother,
  onClose,
}: {
  agent: { id: string; name: string; style: AgentStyle }
  /** One plain line: kind, CLI or model, access. */
  detail: string
  /** Missing where adding another doesn't apply (import). */
  onAnother?: () => void
  onClose: () => void
}) {
  return (
    <section className="team-added" aria-labelledby="team-added-title" role="status">
      <div className="team-added-head">
        <AgentGlyph agent={agent} size="lg" />
        <div>
          <h2 id="team-added-title">{agent.name} joined the team</h2>
          <p className="team-muted">{detail}</p>
        </div>
      </div>
      <div className="team-added-actions">
        <Link
          className="team-primary"
          to={`/team/${encodeURIComponent(agent.id)}`}
          onClick={onClose}
          autoFocus
        >
          Open {agent.name}
        </Link>
        {onAnother && (
          <button type="button" className="team-pill-button" onClick={onAnother}>
            Add another
          </button>
        )}
        <button type="button" className="team-pill-button" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  )
}
