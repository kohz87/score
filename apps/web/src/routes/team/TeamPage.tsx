import { useContext } from 'react'
import { Link, NavLink, Outlet } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { activityOfStatus } from '../../components/agent-activity.ts'
import { StreamContext, useStreamQuery } from '../../data/query-client.ts'
import { agentsQuery, statusLabels } from './team-queries.ts'
import './team.css'
import { AddAgent } from './AddAgent.tsx'
import { ImportAgent } from './ImportAgent.tsx'

export function TeamLayout() {
  const agents = useStreamQuery(agentsQuery)
  return (
    <div className="team-layout">
      <nav className="team-members" aria-label="Team members">
        <NavLink className="team-all" to="/team" end>
          All agents
        </NavLink>
        {agents.data
          ?.filter((agent) => agent.lifecycle?.state !== 'removed')
          .map((agent) => (
            <NavLink key={agent.id} to={`/team/${encodeURIComponent(agent.id)}`}>
              <AgentGlyph
                agent={agent}
                decorative
                contrast="high"
                activity={activityOfStatus(agent.status)}
              />
              <span>{agent.name}</span>
            </NavLink>
          ))}
        <AddAgent agents={agents.data ?? []} />
        <ImportAgent agents={agents.data ?? []} />
      </nav>
      <div className="team-content">
        <Outlet />
      </div>
    </div>
  )
}

export function TeamPage() {
  const agents = useStreamQuery(agentsQuery)
  const context = useContext(StreamContext)
  return (
    <>
      <div className="team-list-heading">
        <h1>Team</h1>
        <p>Your agents, at a glance.</p>
      </div>
      {agents.status === 'pending' && !agents.data && <p role="status">Loading agents…</p>}
      {agents.status === 'error' && (
        <section className="team-card" role="alert">
          <h2>Couldn’t load the team</h2>
          <p className="team-muted-strong">
            Check that the Score server is running, then try again.
          </p>
          <button
            type="button"
            className="team-text-action"
            onClick={() => void context?.queries.register(agentsQuery).refetch()}
          >
            Try again
          </button>
        </section>
      )}
      {agents.status === 'success' && agents.data?.length === 0 && (
        <section className="team-card">
          <h2>No agents yet</h2>
          <p className="team-muted-strong">
            Agents you add will appear here. Start with Add agent.
          </p>
        </section>
      )}
      <ul className="team-list">
        {agents.data
          ?.filter((agent) => agent.lifecycle?.state !== 'removed')
          .map((agent) => (
            <li key={agent.id}>
              <Link
                className="team-card team-agent-card"
                to={`/team/${encodeURIComponent(agent.id)}`}
              >
                <AgentGlyph
                  agent={agent}
                  describeShape
                  contrast="high"
                  activity={activityOfStatus(agent.status)}
                />
                <h2>{agent.name}</h2>
                <p className="team-muted-strong">{agent.role || 'No role set'}</p>
                <p className="team-status">
                  {agent.lifecycle?.state === 'ready'
                    ? 'Ready'
                    : agent.lifecycle
                      ? agent.activity
                      : statusLabels[agent.status]}
                </p>
                <p aria-live="polite">{agent.activity ?? 'No current activity'}</p>
                <span className="team-muted">{agent.model?.label ?? 'Model unavailable'}</span>
                {agent.runtimeNote && <span className="team-muted">{agent.runtimeNote}</span>}
              </Link>
            </li>
          ))}
      </ul>
    </>
  )
}
