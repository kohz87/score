import type { AgentSummary } from '@score/contract'
import { Link } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { useRoutines } from '../team/routine-queries.ts'

function AgentRoutines({ agent }: { agent: AgentSummary }) {
  const routines = useRoutines(agent.id)
  return (
    <section className="now-card now-routines-agent" aria-label={`${agent.name} routines`}>
      <div className="now-card-head">
        <AgentGlyph agent={agent} size="sm" />
        <h2>{agent.name}</h2>
        <span className="now-grow" />
        <Link to={`/team/${encodeURIComponent(agent.id)}`}>Manage in Team</Link>
      </div>
      {routines.isPending ? (
        <p className="now-empty" role="status">
          Loading routines…
        </p>
      ) : routines.isError ? (
        <p className="now-error" role="alert">
          Couldn’t load routines.
        </p>
      ) : routines.data.length === 0 ? (
        <p className="now-empty">No routines yet. Add one on the agent’s Team page.</p>
      ) : (
        <ul className="now-routine-list">
          {routines.data.map((routine) => (
            <li key={routine.id}>
              <span className="now-routine-title">{routine.title}</span>
              <span className="now-routine-schedule">{routine.schedule}</span>
              <span
                className={`now-routine-state${routine.enabled ? '' : ' now-routine-state--off'}`}
              >
                {routine.enabled ? 'On' : 'Paused'}
              </span>
              <span className="now-routine-last">
                {routine.lastRunAt
                  ? `Last run ${new Date(routine.lastRunAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`
                  : 'Never run'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Read-only: every agent's routines. Editing stays on the Team page. */
export function RoutinesView({ agents }: { agents: AgentSummary[] | undefined }) {
  if (!agents)
    return (
      <p className="now-empty" role="status">
        Loading routines…
      </p>
    )
  return (
    <div className="now-routines">
      {agents.map((agent) => (
        <AgentRoutines key={agent.id} agent={agent} />
      ))}
    </div>
  )
}
