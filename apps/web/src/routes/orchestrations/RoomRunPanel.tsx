import type { AgentSummary, OrchestrationSummary } from '@score/contract'
import { Link } from 'react-router'
import { isRunOver } from './orch-model.ts'
import { useRun, useRunActions } from './orchestration-queries.ts'
import { RunNeeds } from './RunDecisions.tsx'
import {
  BudgetBlock,
  FinishBlock,
  PlanList,
  RunControls,
  RunStatus,
  StepCard,
} from './RunPanel.tsx'
import './orchestrations.css'

/** The orchestration's own view above its room's thread: plan, steps, decisions inline, controls, finish. */
export function RoomRunPanel({
  summary,
  agents,
}: {
  summary: OrchestrationSummary
  agents: AgentSummary[]
}) {
  const run = useRun(summary.id)
  const actions = useRunActions(summary.id)
  const detail = run.data?.snapshot.orchestration
  return (
    <details
      className="orch-room"
      open={!isRunOver(summary.status) || summary.needsYou.length > 0}
      aria-label="Orchestration"
    >
      <summary>
        <strong>Orchestration</strong> · {summary.title}
        {summary.needsYou.length > 0 && (
          <span className="orch-pill">Needs you ({summary.needsYou.length})</span>
        )}
      </summary>
      {run.isError && (
        <p role="alert" className="orch-error">
          The run could not load.{' '}
          <button type="button" onClick={() => void run.refetch()}>
            Try again
          </button>
        </p>
      )}
      {!detail && !run.isError && <p role="status">Loading the run…</p>}
      {detail && (
        <div className="orch-room-body">
          <p className="orch-goal">{detail.goal}</p>
          <RunStatus run={detail} />
          <RunControls run={detail} actions={actions} />
          <p className="orch-muted">
            Room messages are the run&apos;s own; use these controls instead of the composer while
            it runs.{' '}
            <Link to={`/now/flow/${encodeURIComponent(detail.briefId)}`}>
              Open the live diagram
            </Link>
          </p>
          <RunNeeds run={detail} agents={agents} actions={actions} />
          <h3>Plan</h3>
          <PlanList run={detail} />
          <h3>Steps</h3>
          {detail.stepsList.length === 0 && <p className="orch-muted">No steps yet.</p>}
          <div className="orch-steps">
            {detail.stepsList.map((step) => (
              <StepCard key={step.id} step={step} run={detail} agents={agents} />
            ))}
          </div>
          <FinishBlock run={detail} />
          <details>
            <summary>Budget and limits</summary>
            <BudgetBlock run={detail} />
          </details>
        </div>
      )}
    </details>
  )
}
