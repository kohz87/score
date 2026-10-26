import { OpenTerminals } from '../routes/settings/TerminalSection.tsx'
import { Link } from 'react-router'
import type { AgentSummary } from '@score/contract'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { useStreamQuery } from '../data/query-client.ts'
import { agentsQuery } from '../routes/chat/queries.ts'
import { RemoteSection } from '../routes/settings/RemoteSection.tsx'
import { useSecurityStatus } from '../routes/settings/settings-queries.ts'
import { useRunsOn } from './runs-on-queries.ts'

const SEPARATED = {
  no: 'Not separated',
  partly: 'Partly separated',
  unknown: 'Not known',
} as const

function runsOnLine(runsOn: ReturnType<typeof useRunsOn>): string {
  if (runsOn.isPending) return 'Reading Hermes…'
  if (runsOn.isError) return 'Couldn’t read where it runs.'
  const data = runsOn.data
  if (data.backend === 'local') return 'This machine, as you'
  if (data.backend === 'docker')
    return `Docker${data.docker?.image ? ` · ${data.docker.image}` : ''}`
  if (data.backend === 'ssh')
    return `SSH · ${data.ssh?.user ? `${data.ssh.user}@` : ''}${data.ssh?.host ?? 'no host'}`
  return `Another backend (${data.raw ?? 'unknown'})`
}

function AgentWhere({ agent }: { agent: AgentSummary }) {
  const runsOn = useRunsOn(agent.id)
  return (
    <li className="bold-agent-where">
      <span className="bold-agent-where-name">
        <AgentGlyph agent={agent} size="xs" bare decorative />
        <b>{agent.name}</b>
      </span>
      <span className="small muted">{runsOnLine(runsOn)}</span>
      {runsOn.data && (
        <span className={`badge runs-on-${runsOn.data.separated}`}>
          {SEPARATED[runsOn.data.separated]}
        </span>
      )}
      <Link className="link" to={`/b/team/${encodeURIComponent(agent.id)}#agent-where`}>
        Runs on
      </Link>
    </li>
  )
}

/** PLAN 11.9b: Remote access and security, with the Where agents run card filled in by 11.8a. */
export function BoldSecurity() {
  const security = useSecurityStatus()
  const agents = useStreamQuery(agentsQuery).data ?? []

  return (
    <div className="bold-security">
      <h2 id="settings-security">Remote access and security</h2>

      <section className="card" aria-labelledby="security-where">
        <h3 id="security-where">Where agents run</h3>
        {agents.length === 0 ? (
          <p className="small muted">No agents yet.</p>
        ) : (
          <ul className="bold-agent-where-list" aria-label="Where agents run">
            {agents.map((agent) => (
              <AgentWhere key={agent.id} agent={agent} />
            ))}
          </ul>
        )}
        <p className="small muted">
          Working with other teams? Give each team its own Score (one machine or VM each). Teams
          share work through the app they work on, with its tool server and triggers, not by sharing
          a Score.
        </p>
      </section>

      <RemoteSection available heading={null} labelledBy="settings-security" showTerminal={false} />

      <section className="card" aria-labelledby="security-terminal">
        <h3 id="security-terminal">Terminal in the browser</h3>
        <p className="small muted">
          A shell on the Score machine. Off unless Score was started with it, HTTPS only, closes
          after 15 minutes idle, at most two open.
        </p>
        {!security.data?.terminal && (
          <p className="small muted">
            {security.data?.terminalUnavailable
              ? `Unavailable: ${security.data.terminalUnavailable} (see docs/SETUP.md).`
              : 'Start Score with SCORE_TERMINAL=1 to turn it on. It needs the security password each time.'}
          </p>
        )}
        <Link className={security.data?.terminal ? 'btn sm primary' : 'btn sm'} to="/terminal">
          Open the terminal
        </Link>
        <OpenTerminals className="security-terminals" />
      </section>
    </div>
  )
}
