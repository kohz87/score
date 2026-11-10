import type { AgentDetail } from '@score/contract'
import { Link } from 'react-router'
import { useStreamQuery } from '../../data/query-client.ts'
import { useAgentAssigned } from '../assigned/assigned-queries.ts'
import { assignedCounts, assignedNames, assignedTasks } from '../assigned/assigned-model.ts'
import { allTasksQuery } from '../room/task-queries.ts'

/**
 * Work's read-only "Assigned" line (decision 183): the repeating jobs, recipe steps and open tasks set to this agent.
 * Nothing is edited here; Open in Tasks and Start a repeating job go to the Tasks screens.
 */
export function AssignedTile({ agent }: { agent: AgentDetail }) {
  const assigned = useAgentAssigned(agent.id)
  const tasksState = useStreamQuery(allTasksQuery)
  const pending = assigned.isPending || tasksState.status === 'pending'
  const failed = assigned.isError || tasksState.status === 'error'
  const tasks = assignedTasks(tasksState.data?.tasks ?? [], agent.id)
  const counts = assigned.data ? assignedCounts(assigned.data, tasks) : null
  const names = assigned.data ? assignedNames(assigned.data) : []
  const heading = counts
    ? `Assigned · ${counts.repeating} repeating, ${counts.tasks} tasks`
    : 'Assigned'
  return (
    <section
      className="bold-agent-summary bold-agent-tile bold-assigned-tile"
      aria-labelledby="agent-assigned-title"
    >
      <h3 id="agent-assigned-title">{heading}</h3>
      {pending && <p className="small muted">Loading what’s assigned…</p>}
      {failed && <p className="small muted">Couldn’t load what’s assigned.</p>}
      {!pending && !failed && counts && (
        <>
          <p className="small">{names.length ? names.join(' · ') : 'Nothing assigned.'}</p>
          <p className="bold-assigned-links">
            <Link className="link" to={`/b/tasks/repeating?agent=${encodeURIComponent(agent.id)}`}>
              Open in Tasks
            </Link>
            <Link
              className="link"
              to={`/b/tasks/repeating?new=1&agent=${encodeURIComponent(agent.id)}`}
            >
              Start a repeating job
            </Link>
          </p>
        </>
      )}
    </section>
  )
}
