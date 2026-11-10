import type { AgentSummary } from '@score/contract'
import { useState } from 'react'
import { Link } from 'react-router'
import { useStreamQuery } from '../../data/query-client.ts'
import { agentDisplayName } from '../bold-agents.ts'
import { InfoSection } from '../chats/InfoSection.tsx'
import { assignedTasks, nextInText, taskStateWords } from '../assigned/assigned-model.ts'
import { useAgentAssigned } from '../assigned/assigned-queries.ts'
import { allTasksQuery } from '../room/task-queries.ts'

/**
 * Info's "Assigned to {agent}" (decision 183; mock-up 28-tasks-assigned): the agent's repeating jobs, recipe steps and
 * open tasks, each a link into Tasks. Read here, set in Tasks.
 */
export function DirectAssigned({
  agent,
  onNavigate,
}: {
  agent: AgentSummary
  onNavigate?: (() => void) | undefined
}) {
  const assigned = useAgentAssigned(agent.id)
  const tasksState = useStreamQuery(allTasksQuery)
  const name = agentDisplayName(agent)
  // Read once when the section mounts: "next in N h" is as of when the panel opened.
  const [now] = useState(() => Date.now())
  const loading = assigned.isPending || tasksState.status === 'pending'
  const failed = assigned.isError || tasksState.status === 'error'
  const data = assigned.data
  const tasks = assignedTasks(tasksState.data?.tasks ?? [], agent.id)
  const count =
    data && !loading && !failed
      ? data.repeating.length + data.recipeSteps.length + tasks.length
      : null
  return (
    <InfoSection
      kind="assigned"
      headingId="dm-info-assigned"
      title={`Assigned to ${name}`}
      summary={count === null ? '' : String(count)}
    >
      {loading && <p className="bold-chat-note">Loading…</p>}
      {failed && (
        <p className="small bold-dm-error" role="alert">
          Couldn’t load what’s assigned.
        </p>
      )}
      {count === 0 && <p className="bold-chat-note">Nothing assigned.</p>}
      {count !== null && count > 0 && (
        <ul className="bold-chat-topics">
          {data?.repeating.map((job) => {
            const next = nextInText(job.nextRunAt, now)
            return (
              <li key={`job-${job.id}`}>
                <Link
                  to={`/b/tasks/repeating?agent=${encodeURIComponent(agent.id)}`}
                  onClick={onNavigate}
                >
                  {`${job.title} · ${job.schedule}${next ? ` · ${next}` : ''}`}
                </Link>
              </li>
            )
          })}
          {data?.recipeSteps.map((step) => (
            <li key={`step-${step.workflowId}-${step.stepLabel}`}>
              <Link
                to={`/b/tasks/recipes/${encodeURIComponent(step.workflowId)}`}
                onClick={onNavigate}
              >
                {`${step.recipeName} (${step.stepLabel}) · recipe step${step.schedule ? ` · ${step.schedule}` : ''}`}
              </Link>
            </li>
          ))}
          {tasks.map((task) => (
            <li key={`task-${task.id}`}>
              <Link to="/b/tasks" onClick={onNavigate}>
                {`${task.title} · task · ${taskStateWords(task)}`}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link className="bold-chat-knowledge" to="/b/tasks" onClick={onNavigate}>
        All in Tasks
      </Link>
      <p className="small muted">Read here, set in Tasks.</p>
    </InfoSection>
  )
}
