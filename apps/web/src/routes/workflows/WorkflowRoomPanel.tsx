import type { AgentSummary, WorkflowRunSummary } from '@score/contract'
import { useState } from 'react'
import { Link } from '../../shell/framed-paths.tsx'
import { statusLabel } from '../orchestrations/orch-model.ts'
import { AgentChip } from '../orchestrations/RunDecisions.tsx'
import { BudgetBlock, RunControls, StateMark } from '../orchestrations/RunPanel.tsx'
import { WorkflowNeeds } from './WorkflowDecisions.tsx'
import { useWorkflowRun, useWorkflowRunActions } from './workflow-queries.ts'
import { nodeVisual, outcomeLines, showsWaiting, waitingText } from './workflow-run-model.ts'
import '../orchestrations/orchestrations.css'
import './workflows.css'

/**
 * A workflow run's own view at the top of its room's thread (the room is the run's). Only the header row stays in view;
 * the body scrolls with the thread and is open exactly while something needs the person, unless they choose otherwise.
 */
export function WorkflowRoomPanel({
  summary,
  agents,
}: {
  summary: WorkflowRunSummary
  agents: AgentSummary[]
}) {
  const run = useWorkflowRun(summary.id)
  const actions = useWorkflowRunActions(summary.id)
  const detail = run.data?.snapshot.run
  const needs = summary.needsYou.length
  const [chosen, setChosen] = useState<boolean | null>(null)
  const open = chosen ?? needs > 0
  const { graph, note } = outcomeLines(summary)
  return (
    <section className="orch-room wf-room-run" aria-label="Workflow run">
      <div className="orch-room-head">
        <button
          type="button"
          className="orch-room-toggle"
          aria-expanded={open}
          onClick={() => setChosen(!open)}
        >
          <strong>Workflow run</strong> · {summary.title}
        </button>
        <span className={`orch-badge orch-badge--${summary.status}`}>
          {statusLabel[summary.status]}
        </span>
        {graph && <span className="orch-muted">{graph}</span>}
        {needs > 0 && (
          <span className="orch-pill" data-protected="inline">
            Needs you ({needs})
          </span>
        )}
        {detail && <RunControls run={detail} actions={actions} />}
      </div>
      {open && (
        <>
          {run.isError && (
            <p role="alert" className="orch-error">
              Couldn’t load this run.{' '}
              <button type="button" onClick={() => void run.refetch()}>
                Try again
              </button>
            </p>
          )}
          {!detail && !run.isError && <p role="status">Loading the run…</p>}
          {detail && (
            <div className="orch-room-body">
              {note && <p className="wf-outcome-note">{note}</p>}
              <p className="orch-muted">
                {detail.workflowName}, version {detail.version}. This room belongs to the run. Use
                the run controls instead of the composer while it runs.{' '}
                <Link to={`/runs/${encodeURIComponent(detail.briefId)}`}>
                  Open the live diagram
                </Link>
              </p>
              <WorkflowNeeds run={detail} agents={agents} actions={actions} />
              <h3>Steps</h3>
              <div className="orch-steps">
                {detail.nodeStates.map((node) => {
                  const def = detail.definition.nodes.find((item) => item.id === node.nodeId)
                  return (
                    <article
                      key={node.nodeId}
                      className="orch-step"
                      aria-label={`${def?.label ?? node.nodeId}, ${node.state}`}
                    >
                      <header>
                        <strong>{def?.label ?? node.nodeId}</strong>
                        {def?.kind === 'agent' && (
                          <AgentChip agentId={def.agentId} agents={agents} />
                        )}
                        <StateMark visual={nodeVisual(node.state)} />
                        {showsWaiting(node) && (
                          <span className="orch-muted">{waitingText[node.waitingFor]}</span>
                        )}
                      </header>
                      {node.verdict && (
                        <p className="orch-muted">
                          Verdict: {node.verdict.verdict.replace('_', ' ')}. {node.verdict.reason}
                        </p>
                      )}
                      {node.output && (
                        <details>
                          <summary>Output (result version {node.outputRevision})</summary>
                          <pre className="orch-pre">{node.output}</pre>
                        </details>
                      )}
                    </article>
                  )
                })}
              </div>
              <details>
                <summary>Budget and limits</summary>
                <BudgetBlock run={detail} coding={detail.coding} />
              </details>
            </div>
          )}
        </>
      )}
    </section>
  )
}
