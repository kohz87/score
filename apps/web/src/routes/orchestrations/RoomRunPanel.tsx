import type { AgentSummary, OrchestrationSummary } from '@score/contract'
import { useState } from 'react'
import { Link } from '../../shell/framed-paths.tsx'
import { leadSteps, orchCoding, statusLabel } from './orch-model.ts'
import { useRun, useRunActions } from './orchestration-queries.ts'
import { AdvisorCard } from './AdvisorCard.tsx'
import { CheckCard } from './CheckCard.tsx'
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

/**
 * The orchestration's own view at the top of its room's thread. Only the header row (title, status, Needs you count,
 * run controls) stays in view; the body scrolls with the thread and is collapsed unless something needs the person.
 */
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
  const needs = summary.needsYou.length
  // The person's own choice wins; until then it is open exactly while something needs them.
  const [chosen, setChosen] = useState<boolean | null>(null)
  const open = chosen ?? needs > 0
  return (
    <section className="orch-room" aria-label="Orchestration">
      <div className="orch-room-head">
        <button
          type="button"
          className="orch-room-toggle"
          aria-expanded={open}
          onClick={() => setChosen(!open)}
        >
          <strong>Orchestration</strong> · {summary.title}
        </button>
        <span className={`orch-badge orch-badge--${summary.status}`}>
          {statusLabel[summary.status]}
        </span>
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
              <p className="orch-goal">{detail.goal}</p>
              <RunStatus run={detail} badge={false} />
              <p className="orch-muted">
                This room belongs to the run. Use the run controls instead of the composer while it
                runs.{' '}
                <Link to={`/runs/${encodeURIComponent(detail.briefId)}`}>
                  Open the live diagram
                </Link>
              </p>
              <RunNeeds run={detail} agents={agents} actions={actions} />
              <h3>Plan</h3>
              <PlanList run={detail} />
              <h3>Steps</h3>
              {leadSteps(detail.stepsList).length === 0 && (
                <p className="orch-muted">No steps yet.</p>
              )}
              <div className="orch-steps">
                {leadSteps(detail.stepsList).map((step) => (
                  <StepCard key={step.id} step={step} run={detail} agents={agents} />
                ))}
              </div>
              <AdvisorCard run={detail} agents={agents} />
              <CheckCard run={detail} actions={actions} />
              <FinishBlock run={detail} />
              <details>
                <summary>Budget and limits</summary>
                <BudgetBlock
                  run={detail}
                  coding={orchCoding(detail.coding, detail.quotaFloorPercent)}
                />
              </details>
            </div>
          )}
        </>
      )}
    </section>
  )
}
