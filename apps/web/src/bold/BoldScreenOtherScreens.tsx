import type { AgentSummary, WatchOverviewItem } from '@score/contract'
import { Link } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { agentDisplayName } from './bold-agents.ts'
import { boldAgentScreenLink } from './bold-links.ts'

export function BoldScreenOtherScreens({
  agent,
  others,
}: {
  agent: AgentSummary
  others: { items: WatchOverviewItem[] | undefined; failed: boolean }
}) {
  const otherScreens = (others.items ?? []).filter((item) => item.agent.id !== agent.id)
  return (
    <nav className="bold-screen-others" aria-label="Other screens">
      <span className="bold-screen-others-title">Other screens</span>
      {others.items === undefined && (
        <span className="bold-screen-others-note" role={others.failed ? 'alert' : 'status'}>
          {others.failed ? 'Couldn’t load the other screens.' : 'Loading the other screens…'}
        </span>
      )}
      {others.items && otherScreens.length === 0 && (
        <span className="bold-screen-others-note">No other agents are on the team yet.</span>
      )}
      {otherScreens.map((item) => (
        <Link
          key={item.agent.id}
          className="bold-screen-chip"
          to={boldAgentScreenLink(item.agent.id)}
        >
          <AgentGlyph agent={item.agent} size="xs" decorative />
          <span>{agentDisplayName(item.agent)}</span>
          <span className="bold-screen-chip-status">
            {item.live && <span className="bold-screen-chip-live" aria-hidden="true" />}
            {item.status}
          </span>
        </Link>
      ))}
    </nav>
  )
}
