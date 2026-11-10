import { Link } from 'react-router'
import { useStreamQuery } from '../../data/query-client.ts'
import { statusLabel } from '../../routes/orchestrations/orch-model.ts'
import { workflowRunsQuery } from '../../routes/workflows/workflow-queries.ts'
import { boldRunLink } from '../bold-links.ts'
import { RepeatsCard } from './RepeatsCard.tsx'

const day = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
    .format(new Date(iso))
    .replace(/^(\w{3}),/, '$1')

function LastRuns({ workflowId }: { workflowId: string }) {
  const runs = useStreamQuery(workflowRunsQuery).data
  const mine = (runs ?? []).filter((run) => run.workflowId === workflowId).slice(0, 5)
  return (
    <section className="bold-rs" aria-label="Last runs">
      <h2>Last runs</h2>
      {mine.length === 0 ? (
        <p className="muted">Not run yet.</p>
      ) : (
        <ul className="bold-rs-runs">
          {mine.map((run) => (
            <li key={run.id}>
              {day(run.createdAt)} · {statusLabel[run.status]}
              {run.outcomeNote ? ` · ${run.outcomeNote}` : ''} ·{' '}
              <Link to={boldRunLink(run.briefId)}>Open job</Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The column beside a saved recipe (mock-up 28-tasks-recipe): Repeats, what a step's model means, and its last runs. */
export function RecipeSidePanels({ workflowId }: { workflowId: string }) {
  return (
    <aside className="bold-rs-col" aria-label="Repeats and runs">
      <RepeatsCard workflowId={workflowId} />
      <section className="bold-rs" aria-label="Before each run">
        <h2>Before each run</h2>
        <p>
          The run’s card shows the steps with their models, so a costly one is seen before it
          starts. Each step’s model wins for that step; the chat’s /model doesn’t apply to a
          recipe’s steps.
        </p>
      </section>
      <LastRuns workflowId={workflowId} />
    </aside>
  )
}
