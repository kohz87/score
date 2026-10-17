import type { AgentSummary, CodingWorkerPreflight, CostSource } from '@score/contract'
import { ORCH_LIMITS } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Arrival } from '../../motion/Arrival.tsx'
import { resetText } from '../team/QuotaMeters.tsx'
import { readinessText } from './orch-model.ts'
import { limitPhrase } from './quota-text.ts'
import { AgentChip, ErrorLine } from './decision-parts.tsx'
import './orchestrations.css'

// The decision cards for coding agents, shared by orchestrations and workflows (7.7c). They know nothing about either:
// they take the run's `coding` block, a `preflightWorker(agentId)` callback and the action callbacks as props, so a
// workflow needs no lead and an orchestration no workflow view.

/**
 * What a run is currently allowed to do with coding agents: the same facts an orchestration's detail and a workflow's
 * summary report. `used` and `unknownSpend` are only known to workflows.
 */
export interface RunCoding {
  workers: readonly { agentId: string; runtime: 'claude-code' | 'codex' }[]
  codingSteps: number
  used?: number
  acceptedUnknownCost: readonly CostSource[]
  /** `continue` = every source's unknown cost is already accepted. */
  unknownSpend?: 'pause' | 'continue'
  /** 8.6: the run's own quota floor; null or absent = each coding agent's own. */
  quotaFloorPercent?: number | null | undefined
}

/** The run's own check of one coding agent: what it can do now. Orchestrations ask with their lead, workflows without. */
export type PreflightWorker = (agentId: string) => Promise<CodingWorkerPreflight | undefined>

/** An agent's settings changed since the run was approved: use its new settings for this step, or stop the run. */
export function PolicyChangedCard({
  scope,
  arrivalKey,
  what,
  agentId,
  agents,
  preflightWorker,
  onUse,
  pending,
  error,
}: {
  /** The run's id: keeps one run's check apart from another's. */
  scope: string
  arrivalKey: string
  /** What the card calls the blocked step (an orchestration's step id, a workflow's node title). */
  what: string
  agentId: string
  agents: AgentSummary[]
  preflightWorker: PreflightWorker
  onUse: (decision: { policyId: string; acknowledgeCodingReach?: { policyIds: string[] } }) => void
  pending: boolean
  error: unknown
}) {
  // The same check the start dialog ran, for this one agent: its current settings and what they let it read.
  const check = useQuery({
    queryKey: ['coding-worker', scope, agentId],
    queryFn: async () => (await preflightWorker(agentId)) ?? null,
    retry: false,
    staleTime: 0,
  })
  const worker = check.data ?? undefined
  const [accepted, setAccepted] = useState<string | null>(null)
  const policyId = worker?.policyId ?? null
  const ready = worker?.readiness === 'ready' && policyId !== null
  const wide = worker?.reachBeyondWorkspace === true
  const covered = !wide || accepted === policyId
  return (
    <Arrival
      arrivalId={`policy-${arrivalKey}`}
      className="orch-decision"
      aria-label={`New settings for ${agentId}`}
    >
      <h3>
        Settings changed for <AgentChip agentId={agentId} agents={agents} />
      </h3>
      <p>
        {what} is blocked because {agentId} isn’t set up the way it was when you approved this run.
        Nothing runs until you decide.
      </p>
      {check.isPending && <p role="status">Checking what it can do now…</p>}
      {check.isError && (
        <p role="alert" className="orch-error">
          Couldn’t check what it can do now. Try again in a moment, or stop the run.
        </p>
      )}
      {worker && ready && worker.reach && <p>With the new settings: {worker.reach}</p>}
      {worker && !ready && (
        <p className="orch-error">
          {worker.detail ?? readinessText[worker.readiness]} Fix that first, or stop the run.
        </p>
      )}
      {wide && ready && (
        <label className="orch-check orch-ack">
          <input
            type="checkbox"
            checked={accepted === policyId}
            onChange={(event) => setAccepted(event.target.checked ? policyId : null)}
          />
          <span>I understand what it can read now, and I accept it for this run.</span>
        </label>
      )}
      <div className="orch-actions">
        <button
          type="button"
          className="orch-primary"
          disabled={pending || !ready || !covered}
          onClick={() =>
            policyId &&
            onUse({
              policyId,
              ...(wide ? { acknowledgeCodingReach: { policyIds: [policyId] } } : {}),
            })
          }
        >
          Use the new settings
        </button>
      </div>
      <ErrorLine error={error} />
    </Arrival>
  )
}

/** The run reached its limit of coding steps: raise it so the blocked step can go on. */
export function CodingLimitCard({
  arrivalKey,
  waiting,
  coding,
  onRaise,
  pending,
  error,
}: {
  arrivalKey: string
  /** The step that waits, when the run names one (an orchestration does; a workflow's limit is one item for the run). */
  waiting: string | null
  coding: Pick<RunCoding, 'codingSteps' | 'used'>
  onRaise: (codingSteps: number) => void
  pending: boolean
  error: unknown
}) {
  const current = coding.codingSteps
  const [limit, setLimit] = useState(String(Math.min(current + 5, ORCH_LIMITS.maxCodingSteps)))
  const next = Number(limit)
  const valid = Number.isInteger(next) && next > current && next <= ORCH_LIMITS.maxCodingSteps
  return (
    <Arrival
      arrivalId={`coding-limit-${arrivalKey}`}
      className="orch-decision"
      aria-label="Coding step limit"
    >
      <h3>
        {waiting ? `${waiting} is waiting: the` : 'The'} run reached its limit of coding steps
      </h3>
      <p>
        This run may use up to {current} coding steps, and they are used. Raise the limit to let{' '}
        {waiting ?? 'the waiting step'} go on, or stop the run.
      </p>
      <label className="orch-field">
        <span>New limit (up to {ORCH_LIMITS.maxCodingSteps})</span>
        <input
          type="number"
          min={current + 1}
          max={ORCH_LIMITS.maxCodingSteps}
          value={limit}
          onChange={(event) => setLimit(event.target.value)}
        />
      </label>
      <div className="orch-actions">
        <button
          type="button"
          className="orch-primary"
          disabled={pending || !valid}
          onClick={() => onRaise(next)}
        >
          Raise the limit and continue
        </button>
      </div>
      <ErrorLine error={error} />
    </Arrival>
  )
}

/** What a held step's card needs from the run: the numbers behind the hold. */
export interface QuotaHoldFacts {
  agentId: string
  window: '5 hours' | 'week'
  group: string | null
  leftPercent: number
  resetsAt: string
}

/**
 * A coding agent has less of its limit left than the level set for it, so a step that hasn't started is held (8.6). The
 * three answers are the same for an orchestration step and a workflow step.
 */
export function QuotaLowCard({
  arrivalKey,
  what,
  hold,
  agents,
  onAnswer,
  pending,
  error,
}: {
  arrivalKey: string
  /** What the card calls the held step (an orchestration's step id, a workflow's node title). */
  what: string
  hold: QuotaHoldFacts
  agents: AgentSummary[]
  onAnswer: (answer: 'use_anyway' | 'wait' | 'stop') => void
  pending: boolean
  error: unknown
}) {
  const resets = resetText(hold.resetsAt)
  return (
    <Arrival
      arrivalId={`quota-${arrivalKey}`}
      className="orch-decision"
      aria-label={`${hold.agentId}’s limit is low`}
    >
      <h3>
        {what} is held: <AgentChip agentId={hold.agentId} agents={agents} />
        ’s limit is low
      </h3>
      <p>
        {hold.agentId} has {Math.round(hold.leftPercent)}% of {limitPhrase(hold.window, hold.group)}{' '}
        left
        {resets ? `, and it resets at ${resets}` : ''}. That is under the level set for this agent,
        so {what} hasn’t started. Steps that are already running carry on.
      </p>
      <div className="orch-actions">
        <button
          type="button"
          className="orch-primary"
          disabled={pending}
          onClick={() => onAnswer('use_anyway')}
        >
          Use it anyway
        </button>
        <button type="button" disabled={pending} onClick={() => onAnswer('wait')}>
          Wait until it resets
        </button>
        <button type="button" disabled={pending} onClick={() => onAnswer('stop')}>
          Stop the run
        </button>
      </div>
      <ErrorLine error={error} />
    </Arrival>
  )
}
