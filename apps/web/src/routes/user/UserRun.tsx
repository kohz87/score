import type { AgentSummary, OrchestrationSummary, WorkflowRunSummary } from '@score/contract'
import { statusLabel } from '../orchestrations/orch-model.ts'
import { useRun, useRunActions } from '../orchestrations/orchestration-queries.ts'
import { RunNeeds } from '../orchestrations/RunDecisions.tsx'
import { RunControls, RunStatus } from '../orchestrations/RunPanel.tsx'
import '../orchestrations/orchestrations.css'
import { WorkflowNeeds } from '../workflows/WorkflowDecisions.tsx'
import { useWorkflowRun, useWorkflowRunActions } from '../workflows/workflow-queries.ts'
import { outcomeLines } from '../workflows/workflow-run-model.ts'
import { useViewSwitch } from './ViewSwitch.tsx'

/**
 * The run's header at the top of its room in the user view: what it is, how it is going, Pause and Stop, and a way to
 * the admin view's Flow for the details. The decisions it needs are drawn at the end of the conversation (UserRunNeeds).
 */
export function UserRunPanel({ summary }: { summary: OrchestrationSummary }) {
  const run = useRun(summary.id)
  const actions = useRunActions(summary.id)
  const detail = run.data?.snapshot.orchestration
  const { toAdmin, dialog } = useViewSwitch()
  return (
    <section className="orch-room user-run" aria-label="Orchestration">
      <div className="orch-room-head">
        <strong className="user-run-title">{summary.title}</strong>
        <span className={`orch-badge orch-badge--${summary.status}`}>
          {statusLabel[summary.status]}
        </span>
        {detail && <RunControls run={detail} actions={actions} />}
        <button
          type="button"
          className="user-run-details"
          onClick={() => toAdmin(`/now/flow/${encodeURIComponent(summary.briefId)}`)}
        >
          See full details
        </button>
      </div>
      {run.isError && (
        <p role="alert" className="orch-error">
          Couldn’t load this run.{' '}
          <button type="button" onClick={() => void run.refetch()}>
            Try again
          </button>
        </p>
      )}
      {detail && <RunStatus run={detail} badge={false} />}
      {dialog}
    </section>
  )
}

/** Everything the run needs from the person, answered right in the conversation with the admin view's own cards. */
export function UserRunNeeds({
  summary,
  agents,
}: {
  summary: OrchestrationSummary
  agents: AgentSummary[]
}) {
  const run = useRun(summary.id)
  const actions = useRunActions(summary.id)
  const detail = run.data?.snapshot.orchestration
  if (!detail) return null
  return (
    <div className="user-needs">
      <RunNeeds run={detail} agents={agents} actions={actions} />
    </div>
  )
}

/**
 * A workflow run's header at the top of its room in the user view: the same compact header as an orchestration, with
 * Pause and Stop, and a way to the admin view's diagram. The step list stays in the admin view; what needs the person is
 * drawn at the end of the conversation (UserWorkflowNeeds).
 */
export function UserWorkflowPanel({ summary }: { summary: WorkflowRunSummary }) {
  const run = useWorkflowRun(summary.id)
  const actions = useWorkflowRunActions(summary.id)
  const detail = run.data?.snapshot.run
  const { toAdmin, dialog } = useViewSwitch()
  const { graph, note } = outcomeLines(summary)
  return (
    <section className="orch-room user-run" aria-label="Workflow">
      <div className="orch-room-head">
        <strong className="user-run-title">{summary.title}</strong>
        <span className={`orch-badge orch-badge--${summary.status}`}>
          {statusLabel[summary.status]}
        </span>
        {detail && <RunControls run={detail} actions={actions} />}
        <button
          type="button"
          className="user-run-details"
          onClick={() => toAdmin(`/now/flow/${encodeURIComponent(summary.briefId)}`)}
        >
          See full details
        </button>
      </div>
      {run.isError && (
        <p role="alert" className="orch-error">
          Couldn’t load this run.{' '}
          <button type="button" onClick={() => void run.refetch()}>
            Try again
          </button>
        </p>
      )}
      <div className="orch-status">
        <span className="orch-muted">
          {summary.nodes.succeeded} of {summary.nodes.total} steps done
        </span>
        {graph && <span className="orch-muted">{graph}</span>}
        {note && <span className="orch-muted">{note}</span>}
      </div>
      {dialog}
    </section>
  )
}

/** What the workflow run needs from the person, answered in the conversation with the admin view’s own cards. */
export function UserWorkflowNeeds({
  summary,
  agents,
}: {
  summary: WorkflowRunSummary
  agents: AgentSummary[]
}) {
  const run = useWorkflowRun(summary.id)
  const actions = useWorkflowRunActions(summary.id)
  const detail = run.data?.snapshot.run
  if (!detail) return null
  return (
    <div className="user-needs">
      <WorkflowNeeds run={detail} agents={agents} actions={actions} />
    </div>
  )
}
