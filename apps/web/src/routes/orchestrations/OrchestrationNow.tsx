import type { OrchestrationSummary } from '@score/contract'
import { Link } from 'react-router'
import { useStreamQuery } from '../../data/query-client.ts'
import { taskAgentsQuery } from '../tasks/task-queries.ts'
import { FenceScreen } from './FenceScreen.tsx'
import { orchestrationsQuery, useFence, useRun, useRunActions } from './orchestration-queries.ts'
import { RunNeeds } from './RunDecisions.tsx'
import './orchestrations.css'

function RunNeedsOf({ summary }: { summary: OrchestrationSummary }) {
  const run = useRun(summary.id)
  const actions = useRunActions(summary.id)
  const agents = useStreamQuery(taskAgentsQuery).data ?? []
  const detail = run.data?.snapshot.orchestration
  return (
    <div className="orch-now-run">
      <h3>
        {summary.title}{' '}
        <Link to={`/now/flow/${encodeURIComponent(summary.briefId)}`}>Open the live diagram</Link>
      </h3>
      {detail ? (
        <RunNeeds run={detail} agents={agents} actions={actions} />
      ) : (
        <p role="status">Loading…</p>
      )}
    </div>
  )
}

/** Gates, questions, budget pauses, unknown attempts and the reconciliation list, as typed "Needs you" items. */
export function OrchestrationNow() {
  const runs = useStreamQuery(orchestrationsQuery).data ?? []
  const fence = useFence().data
  const needing = runs.filter((run) => run.needsYou.length > 0)
  if (!fence?.fenced && needing.length === 0) return null
  return (
    <section className="now-card orch-now" aria-label="Orchestrations that need you">
      <div className="now-card-head">
        <h2>Orchestrations need you</h2>
      </div>
      {fence?.fenced && <FenceScreen fence={fence} />}
      {needing.map((run) => (
        <RunNeedsOf key={run.id} summary={run} />
      ))}
    </section>
  )
}
