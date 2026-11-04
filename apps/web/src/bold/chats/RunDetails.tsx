import type { BudgetView, OrchestrationDetail, WorkflowRunDetail } from '@score/contract'
import type { ReactNode } from 'react'
import { useStreamQuery } from '../../data/query-client.ts'
import { taskAgentsQuery } from '../../data/task-queries.ts'
import { AdvisorCard } from '../../routes/orchestrations/AdvisorCard.tsx'
import { CheckCard } from '../../routes/orchestrations/CheckCard.tsx'
import { HelpersCard } from '../../routes/orchestrations/HelpersCard.tsx'
import { orchCoding, usd } from '../../routes/orchestrations/orch-model.ts'
import { useRun, useRunActions } from '../../routes/orchestrations/orchestration-queries.ts'
import { ownText } from '../../routes/workflows/workflow-model.ts'
import { useWorkflowRun } from '../../routes/workflows/workflow-queries.ts'
import { ClassicPaper } from '../ClassicPaper.tsx'
import type { JobRecipe } from '../room/thread-model.ts'
import '../bold-runs.css'

const clock = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null

function SpendTile({ budget }: { budget: BudgetView }) {
  const used = budget.settledUsd + budget.provisionalUsd
  const limit = budget.limitUsd
  const settledPct = limit && limit > 0 ? Math.min(100, (budget.settledUsd / limit) * 100) : 0
  const provisionalPct =
    limit && limit > 0 ? Math.min(100 - settledPct, (budget.provisionalUsd / limit) * 100) : 0
  return (
    <div className="bold-run-tile" aria-label="Spend">
      <span className="bold-run-tile-head">
        <span>Spend</span>
        <b>{limit === null ? usd(used) : `${usd(used)} of ${usd(limit)}`}</b>
      </span>
      {limit !== null && (
        <span className="bold-run-meter" aria-hidden="true">
          <span style={{ width: `${settledPct}%` }} />
          <span className="is-provisional" style={{ width: `${provisionalPct}%` }} />
        </span>
      )}
      <span className="bold-run-tile-sub">
        {usd(budget.settledUsd)} settled · {usd(budget.provisionalUsd)} not settled yet
        {budget.unknownSpend ? ' · some spend is unknown' : ''}
      </span>
    </div>
  )
}

function Tile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bold-run-tile" aria-label={label}>
      <span className="bold-run-tile-head">
        <span>{label}</span>
      </span>
      {children}
    </div>
  )
}

function OrchestrationDetails({ detail }: { detail: OrchestrationDetail }) {
  const agents = useStreamQuery(taskAgentsQuery).data ?? []
  const actions = useRunActions(detail.id)
  const coding = orchCoding(detail.coding, detail.quotaFloorPercent)
  return (
    <>
      <div className="bold-run-tiles">
        <SpendTile budget={detail.budget} />
        <Tile label="Limits">
          <span className="bold-run-tile-line">
            {detail.deadlineAt ? `Deadline ${clock(detail.deadlineAt)}` : 'No deadline'}
          </span>
          <span className="bold-run-tile-sub">
            {detail.untilStopped
              ? `Steps ${detail.steps.total} · lead turns ${detail.leadTurnsUsed} · until you stop it`
              : `Steps ${detail.steps.total} of ${detail.maxSteps} · lead turns ${detail.leadTurnsUsed} of ${detail.maxLeadTurns}`}
            {coding ? ` · coding steps up to ${coding.codingSteps}` : ''}
          </span>
        </Tile>
        <Tile label="Team on this run">
          <span className="bold-run-tile-line">
            {detail.allowedAgents.length} {detail.allowedAgents.length === 1 ? 'agent' : 'agents'}{' '}
            allowed
          </span>
          <span className="bold-run-tile-sub">
            {detail.gatePolicy === 'every-step'
              ? 'Asks you before every step'
              : detail.gatePolicy === 'lead-asks'
                ? 'The lead asks you at gates'
                : 'No approvals needed'}
          </span>
        </Tile>
      </div>
      <ClassicPaper>
        <AdvisorCard run={detail} agents={agents} />
        <HelpersCard run={detail} agents={agents} />
        <CheckCard run={detail} actions={actions} />
      </ClassicPaper>
    </>
  )
}

function WorkflowDetails({ detail }: { detail: WorkflowRunDetail }) {
  return (
    <div className="bold-run-tiles">
      <SpendTile budget={detail.budget} />
      <Tile label="Limits">
        <span className="bold-run-tile-line">
          {detail.deadlineAt ? `Deadline ${clock(detail.deadlineAt)}` : 'No deadline'}
        </span>
        <span className="bold-run-tile-sub">
          {detail.nodes.succeeded} of {detail.nodes.total} steps done
          {detail.nodes.skipped > 0 ? `, ${detail.nodes.skipped} skipped` : ''} ·{' '}
          {detail.gatePolicy === 'every-step'
            ? 'asks before every agent step'
            : 'asks only at gates'}
          {detail.coding
            ? ` · coding steps ${detail.coding.used} of ${detail.coding.codingSteps}`
            : ''}
        </span>
      </Tile>
      <Tile label="Inputs">
        {detail.definition.inputs.length === 0 ? (
          <span className="bold-run-tile-sub">None</span>
        ) : (
          <span className="bold-run-chips">
            {detail.definition.inputs.map((input) => (
              <code key={input.name}>
                {input.label} = {ownText(detail.inputs, input.name)}
              </code>
            ))}
          </span>
        )}
      </Tile>
    </div>
  )
}

function OrchestrationDetailsLoader({ id }: { id: string }) {
  const detail = useRun(id).data?.snapshot.orchestration
  return detail ? (
    <OrchestrationDetails detail={detail} />
  ) : (
    <p className="small muted" role="status">
      Loading the details…
    </p>
  )
}

function WorkflowDetailsLoader({ id }: { id: string }) {
  const detail = useWorkflowRun(id).data?.snapshot.run
  return detail ? (
    <WorkflowDetails detail={detail} />
  ) : (
    <p className="small muted" role="status">
      Loading the details…
    </p>
  )
}

/**
 * 3.29.0: what only the old run page showed, folded under the log: the spend, limits and team summary and, for a
 * lead-decides run, the advisor, helpers and check. Decisions on the run (approvals, reassign, abandon, waivers) are
 * in the chat itself (`room/RunSafetyRequests.tsx`), not here.
 */
export function RunDetails({ recipe }: { recipe: JobRecipe }) {
  return (
    <details className="bold-run-details" aria-label="Run details">
      <summary>Run details</summary>
      {recipe.kind === 'orchestration' ? (
        <OrchestrationDetailsLoader id={recipe.ref} />
      ) : (
        <WorkflowDetailsLoader id={recipe.ref} />
      )}
    </details>
  )
}
