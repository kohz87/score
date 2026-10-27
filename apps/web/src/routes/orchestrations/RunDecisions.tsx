import { Arrival } from '../../motion/Arrival.tsx'
import { gateChip } from '../../live/resolved.ts'
import { ResolvedList } from '../../live/ResolvedList.tsx'
import { useRecentlyResolved } from '../../live/use-recently-resolved.ts'
import type { AgentSummary, NeedsYou, OrchestrationDetail } from '@score/contract'
import { useCallback, useState } from 'react'
import { orchCoding, needsYouText, usd } from './orch-model.ts'
import { fetchPreflight, type DecisionActions, type RunActions } from './orchestration-queries.ts'
import {
  CodingLimitCard,
  PolicyChangedCard,
  QuotaLowCard,
  type PreflightWorker,
  type RunCoding,
} from './CodingCards.tsx'
import { AgentChip, CliBadge, ErrorLine, sourceName } from './decision-parts.tsx'

// The decisions a run asks of the person, each bound to the revision the page showed (contract §14). A stale page
// is answered with `409 conflict`: the run is read again and the person decides again.

export { AgentChip, CliBadge, ErrorLine, sourceName }

/** The parts of a run the shared cards read; a workflow run supplies them from its own view (7.1b). */
export type GateRun = Pick<OrchestrationDetail, 'gates' | 'stepsList' | 'revision'>
export type LimitsRun = Pick<OrchestrationDetail, 'budget' | 'revision'>
export type AttemptsRun = Pick<OrchestrationDetail, 'attempts' | 'revision'>

export function GateCard({
  run,
  gateId,
  agents,
  actions,
  label,
}: {
  run: GateRun
  gateId: string
  agents: AgentSummary[]
  actions: Pick<DecisionActions, 'gate'>
  /** What the card calls the step (a workflow names the node); defaults to the step id. */
  label?: string
}) {
  const gate = run.gates.find((item) => item.id === gateId)
  const [note, setNote] = useState('')
  if (!gate) return null
  const replaced = gate.payload.replaces
    ? run.stepsList.find((step) => step.id === gate.payload.replaces)
    : undefined
  const name = label ?? gate.stepId
  const decide = (decision: 'approve' | 'reject') =>
    actions.gate.mutate({
      gateId,
      body: {
        decision,
        expectedRevision: gate.revision,
        orchestrationRevision: run.revision,
        ...(note.trim() ? { note: note.trim() } : {}),
      },
    })
  return (
    <Arrival
      arrivalId={`gate-${gateId}`}
      data-protected="block"
      className="orch-decision orch-decision--gate"
      aria-label={`Approve ${name}`}
    >
      <h3>
        Approve {name}?{' '}
        <small>{gate.requestedBy === 'lead' ? 'The lead asked' : 'Your gate policy asks'}</small>
      </h3>
      <p className="orch-gate-lead">
        Approving lets exactly this assignment start. If the lead changes its mind, it has to ask
        again.
      </p>
      <dl className="orch-facts">
        <dt>Agent</dt>
        <dd>
          <AgentChip agentId={gate.payload.agentId} agents={agents} />{' '}
          <span
            className="orch-mono"
            title="Identifies the agent’s current set-up. If the agent changes, the step is blocked."
          >
            {gate.payload.agentIncarnation.slice(0, 12)}
          </span>
        </dd>
        <dt>Instruction</dt>
        <dd>
          <pre className="orch-pre">{gate.payload.instruction}</pre>
        </dd>
        <dt>After</dt>
        <dd>
          {gate.payload.after.length === 0
            ? 'Nothing: it can start at once'
            : gate.payload.after
                .map(
                  (id) =>
                    `${id} (result version ${Object.hasOwn(gate.payload.dependencyRevisions, id) ? gate.payload.dependencyRevisions[id] : 0}, ${run.stepsList.find((step) => step.id === id)?.status ?? 'unknown'})`,
                )
                .join(', ')}
        </dd>
        {gate.payload.replaces && (
          <>
            <dt>Replaces</dt>
            <dd>
              {gate.payload.replaces}
              {replaced
                ? ` (${replaced.status}${replaced.disposition ? `: ${replaced.disposition}` : ''})`
                : ''}
              . If the old step was already accepted to run, the new one starts only once it has
              ended.
            </dd>
          </>
        )}
        <dt>Estimate</dt>
        <dd>{usd(gate.payload.estimateUsd)} for this step</dd>
      </dl>
      <label className="orch-field">
        <span>Note for the lead (optional)</span>
        <input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className="orch-actions">
        <button
          type="button"
          className="orch-primary"
          disabled={actions.gate.isPending}
          onClick={() => decide('approve')}
        >
          Approve {name}
        </button>
        <button type="button" disabled={actions.gate.isPending} onClick={() => decide('reject')}>
          Reject
        </button>
      </div>
      <ErrorLine error={actions.gate.error} />
    </Arrival>
  )
}

export function InquiryCard({
  run,
  inquiryId,
  actions,
}: {
  run: OrchestrationDetail
  inquiryId: string
  actions: RunActions
}) {
  const inquiry = run.inquiries.find((item) => item.id === inquiryId)
  const [answer, setAnswer] = useState('')
  if (!inquiry) return null
  return (
    <Arrival
      arrivalId={`inquiry-${inquiryId}`}
      data-protected="block"
      className="orch-decision orch-decision--inquiry"
      aria-label="Question from the lead"
    >
      <h3>The lead asks</h3>
      <p className="orch-quote">{inquiry.question}</p>
      <label className="orch-field">
        <span>
          Your answer (the lead reads it as information only; it never changes permissions)
        </span>
        <textarea
          rows={3}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          maxLength={4000}
        />
      </label>
      <div className="orch-actions">
        <button
          type="button"
          className="orch-primary"
          disabled={actions.inquiry.isPending || answer.trim() === ''}
          onClick={() =>
            actions.inquiry.mutate({
              inquiryId,
              body: {
                answer: answer.trim(),
                expectedRevision: inquiry.revision,
                orchestrationRevision: run.revision,
              },
            })
          }
        >
          Send answer
        </button>
      </div>
      <ErrorLine error={actions.inquiry.error} />
    </Arrival>
  )
}

export function LimitsCard({
  run,
  coding,
  reason,
  actions,
}: {
  run: LimitsRun
  /** The run's current coding authorisation; absent for a run without coding agents. */
  coding?: RunCoding | undefined
  reason: Extract<NeedsYou, { kind: 'budget' }>['reason']
  actions: Pick<DecisionActions, 'limits'>
}) {
  const [budget, setBudget] = useState('')
  const [deadline, setDeadline] = useState('')
  // 8.6: blank leaves the floor as it is; a number from 0 to 50 sets this run's floor for every coding agent.
  const [floor, setFloor] = useState('')
  const floorValue = Number(floor)
  const floorGiven = floor.trim() !== ''
  const floorValid =
    !floorGiven || (Number.isInteger(floorValue) && floorValue >= 0 && floorValue <= 50)
  const apply = () => {
    const raised = Number(budget)
    actions.limits.mutate({
      orchestrationRevision: run.revision,
      ...(budget !== '' && raised > 0 ? { budgetUsd: raised } : {}),
      ...(deadline !== '' ? { deadlineAt: new Date(deadline).toISOString() } : {}),
      ...(floorGiven && floorValid ? { quotaFloorPercent: floorValue } : {}),
    })
  }
  return (
    <Arrival
      arrivalId={`limits-${reason}`}
      data-protected="block"
      className="orch-decision"
      aria-label="Budget or deadline"
    >
      <h3>{needsYouText({ kind: 'budget', reason })}</h3>
      <p>
        Budget {run.budget.limitUsd === null ? 'not set' : usd(run.budget.limitUsd)}; settled{' '}
        {usd(run.budget.settledUsd)}, provisional {usd(run.budget.provisionalUsd)}, reserved{' '}
        {usd(run.budget.reservedUsd)}
        {run.budget.unknownSpend ? ', some spend unknown' : ''}.
      </p>
      <div className="orch-row">
        <label className="orch-field">
          <span>New budget (USD)</span>
          <input
            inputMode="decimal"
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
          />
        </label>
        <label className="orch-field">
          <span>New deadline</span>
          <input
            type="datetime-local"
            value={deadline}
            onChange={(event) => setDeadline(event.target.value)}
          />
        </label>
        {coding && (
          <label className="orch-field">
            <span>
              Quota floor (%){' '}
              {coding.quotaFloorPercent === null || coding.quotaFloorPercent === undefined
                ? '(each agent’s own now)'
                : `(${coding.quotaFloorPercent}% now)`}
            </span>
            <input
              type="number"
              min={0}
              max={50}
              inputMode="numeric"
              value={floor}
              aria-invalid={!floorValid}
              onChange={(event) => setFloor(event.target.value)}
            />
          </label>
        )}
      </div>
      <div className="orch-actions">
        <button
          type="button"
          className="orch-primary"
          disabled={
            actions.limits.isPending ||
            !floorValid ||
            (budget === '' && deadline === '' && !floorGiven)
          }
          onClick={apply}
        >
          Apply and continue
        </button>
        {reason === 'unknown_spend' && (
          <button
            type="button"
            disabled={actions.limits.isPending}
            onClick={() =>
              actions.limits.mutate({
                orchestrationRevision: run.revision,
                acceptUnknownSpend: true,
              })
            }
          >
            Continue although spend is unknown
          </button>
        )}
        {reason === 'unknown_spend' &&
          coding &&
          coding.unknownSpend !== 'continue' &&
          (['claude-code', 'codex'] as const)
            .filter((source) => coding.workers.some((worker) => worker.runtime === source))
            .filter((source) => !coding.acceptedUnknownCost.includes(source))
            .map((source) => (
              <button
                key={source}
                type="button"
                disabled={actions.limits.isPending}
                onClick={() =>
                  actions.limits.mutate({
                    orchestrationRevision: run.revision,
                    acceptUnknownCost: { add: [source] },
                  })
                }
              >
                Continue although {sourceName(source)} cost is unknown
              </button>
            ))}
      </div>
      <ErrorLine error={actions.limits.error} />
    </Arrival>
  )
}

export function UnknownCard({
  run,
  attemptId,
  actions,
  fenceStepId,
  label,
}: {
  run: AttemptsRun
  attemptId: string
  /** What the card calls the step (a workflow names the node). */
  label?: string
  actions: Pick<DecisionActions, 'abandon' | 'waiver'>
  /** The same attempt also fences the run as a cancelled step: its waiver is offered on this card. */
  fenceStepId?: string
}) {
  const attempt = run.attempts.find((item) => item.id === attemptId)
  const [sure, setSure] = useState(false)
  const [waive, setWaive] = useState(false)
  if (!attempt) return null
  return (
    <Arrival
      arrivalId={`unknown-${attemptId}`}
      data-protected="block"
      className="orch-decision"
      aria-label="Not confirmed as ended"
    >
      <h3>Not confirmed as ended: {label ?? attempt.stepId ?? 'lead turn'}</h3>
      <p>
        {attempt.unknownReason === 'run_cancelled' && attempt.stopRequestedAt
          ? 'Hermes cancelled the run after it was stopped, but doesn’t confirm that everything the agent started (a tool call, a command) has finished.'
          : `Hermes hasn’t said this work finished (${unknownReasonText(attempt.unknownReason)}).`}{' '}
        Score keeps trying to stop it. Until it ends, nothing new starts.
      </p>
      <p className="small">
        If you’re sure it’s done, or don’t mind: Stop waiting for this closes the turn and the run
        moves on; anything it sends later is ignored.
      </p>
      <label className="orch-check">
        <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
        This may still be running. Score keeps trying to stop it and ignores any late results.
      </label>
      <div className="orch-actions">
        <button
          type="button"
          disabled={!sure || actions.abandon.isPending}
          onClick={() =>
            actions.abandon.mutate({
              attemptIds: [attemptId],
              orchestrationRevision: run.revision,
              acknowledge: true,
            })
          }
        >
          Stop waiting for this
        </button>
      </div>
      <ErrorLine error={actions.abandon.error} />
      {fenceStepId && (
        <>
          <p>
            It is also the stopped step {fenceStepId}: nothing new starts until it has ended. You
            can continue while it may still run instead. That is recorded; it doesn’t prove that it
            stopped.
          </p>
          <label className="orch-check">
            <input
              type="checkbox"
              checked={waive}
              onChange={(event) => setWaive(event.target.checked)}
            />
            Continue while the stopped step may still run.
          </label>
          <div className="orch-actions">
            <button
              type="button"
              disabled={!waive || actions.waiver.isPending}
              onClick={() =>
                actions.waiver.mutate({ orchestrationRevision: run.revision, acknowledge: true })
              }
            >
              Continue anyway
            </button>
          </div>
          <ErrorLine error={actions.waiver.error} />
        </>
      )}
    </Arrival>
  )
}

export function CancelFenceCard({
  run,
  stepId,
  actions,
}: {
  run: Pick<OrchestrationDetail, 'revision'>
  stepId: string
  actions: Pick<DecisionActions, 'waiver'>
}) {
  const [sure, setSure] = useState(false)
  return (
    <Arrival
      arrivalId={`cancel-${stepId}`}
      data-protected="block"
      className="orch-decision"
      aria-label="Stopped step may still run"
    >
      <h3>Stopped {stepId} may still be running</h3>
      <p>
        Nothing new starts until it has ended. You can also continue while it may still run. That is
        recorded; it doesn’t prove that it stopped.
      </p>
      <label className="orch-check">
        <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
        Continue while the stopped step may still run.
      </label>
      <div className="orch-actions">
        <button
          type="button"
          disabled={!sure || actions.waiver.isPending}
          onClick={() =>
            actions.waiver.mutate({ orchestrationRevision: run.revision, acknowledge: true })
          }
        >
          Continue anyway
        </button>
      </div>
      <ErrorLine error={actions.waiver.error} />
    </Arrival>
  )
}

/** An agent was replaced after the run started: use the new one for the rest of the run, or Stop the run. */
export function RemapCard({
  run,
  item,
  agents,
  actions,
}: {
  run: OrchestrationDetail
  item: Extract<NeedsYou, { kind: 'remap' }>
  agents: AgentSummary[]
  actions: RunActions
}) {
  const gone = item.currentIncarnation === 'untracked'
  return (
    <Arrival
      arrivalId={`remap-${item.agentId}`}
      data-protected="block"
      className="orch-decision"
      aria-label={`Replaced ${item.agentId}`}
    >
      <h3>
        <AgentChip agentId={item.agentId} agents={agents} /> was replaced
        <small>{item.role === 'lead' ? ' The lead of this run' : ' An agent of this run'}</small>
      </h3>
      <p>
        {gone
          ? 'This agent no longer exists, so the run can’t use it. You can stop the run.'
          : `This run was started with the earlier ${item.agentId}. Nothing is assigned to the new one until you decide. Steps already given to the earlier one stay blocked, and the lead assigns them again.`}
      </p>
      <div className="orch-actions">
        {!gone && (
          <button
            type="button"
            disabled={actions.remap.isPending}
            onClick={() =>
              actions.remap.mutate({
                agentId: item.agentId,
                frozenIncarnation: item.frozenIncarnation,
                currentIncarnation: item.currentIncarnation,
                orchestrationRevision: run.revision,
                acknowledge: true,
              })
            }
          >
            Use the new {item.agentId} for this run
          </button>
        )}
      </div>
      <ErrorLine error={actions.remap.error} />
    </Arrival>
  )
}

/** Every item the run needs from the person, typed as the server lists them (`needsYou[]`). */
export function RunNeeds({
  run,
  agents,
  actions,
}: {
  run: OrchestrationDetail
  agents: AgentSummary[]
  actions: RunActions
}) {
  // The run's own check of a coding agent: its preflight with this lead and that one agent.
  const leadAgentId = run.leadAgentId
  const preflightWorker = useCallback<PreflightWorker>(
    async (agentId) =>
      (await fetchPreflight(leadAgentId, [agentId])).workers.find(
        (entry) => entry.agentId === agentId,
      ),
    [leadAgentId],
  )
  const coding = orchCoding(run.coding, run.quotaFloorPercent)
  const openGates = new Set(
    run.needsYou.flatMap((item) => (item.kind === 'gate' ? [item.gateId] : [])),
  )
  // A decided gate stays where it was, as a chip, for a moment.
  const decided = useRecentlyResolved(openGates, (id) => {
    const gate = run.gates.find((item) => item.id === id)
    const chip = gate ? gateChip(gate) : null
    return gate && chip ? { label: gate.stepId, chip } : null
  })
  if (run.needsYou.length === 0 && decided.length === 0) return null
  // A cancelled step whose attempt is also not confirmed ended is one card with both actions.
  const unknownIds = new Set(
    run.needsYou.flatMap((item) => (item.kind === 'unknown' ? [item.attemptId] : [])),
  )
  const fenceFor = (attemptId: string): { fenceStepId?: string } => {
    const fence = run.needsYou.find(
      (item) => item.kind === 'cancel_fence' && item.attemptId === attemptId,
    )
    return fence?.kind === 'cancel_fence' ? { fenceStepId: fence.stepId } : {}
  }
  return (
    <div className="orch-needs" aria-label="Needs you" data-protected="grid">
      <ResolvedList items={decided} />
      {run.needsYou.map((item) => {
        switch (item.kind) {
          case 'gate':
            return (
              <GateCard
                key={`g${item.gateId}`}
                run={run}
                gateId={item.gateId}
                agents={agents}
                actions={actions}
              />
            )
          case 'inquiry':
            return (
              <InquiryCard
                key={`q${item.inquiryId}`}
                run={run}
                inquiryId={item.inquiryId}
                actions={actions}
              />
            )
          case 'budget':
            return (
              <LimitsCard
                key={`b${item.reason}`}
                run={run}
                coding={coding}
                reason={item.reason}
                actions={actions}
              />
            )
          case 'unknown':
            return (
              <UnknownCard
                key={`u${item.attemptId}`}
                run={run}
                attemptId={item.attemptId}
                actions={actions}
                {...fenceFor(item.attemptId)}
              />
            )
          case 'cancel_fence':
            if (unknownIds.has(item.attemptId)) return null
            return (
              <CancelFenceCard
                key={`c${item.attemptId}`}
                run={run}
                stepId={item.stepId}
                actions={actions}
              />
            )
          case 'remap':
            return (
              <RemapCard
                key={`m${item.agentId}`}
                run={run}
                item={item}
                agents={agents}
                actions={actions}
              />
            )
          case 'policy_changed':
            return (
              <PolicyChangedCard
                key={`pc${item.stepId}`}
                scope={run.id}
                arrivalKey={item.stepId}
                what={item.stepId}
                agentId={item.agentId}
                agents={agents}
                preflightWorker={preflightWorker}
                pending={actions.policyRemap.isPending}
                error={actions.policyRemap.error}
                onUse={(decision) =>
                  actions.policyRemap.mutate({
                    stepId: item.stepId,
                    body: {
                      agentId: item.agentId,
                      ...decision,
                      orchestrationRevision: run.revision,
                    },
                  })
                }
              />
            )
          case 'quota_low':
            return (
              <QuotaLowCard
                key={`ql${item.stepId}`}
                arrivalKey={item.stepId}
                what={item.stepId}
                hold={item}
                agents={agents}
                pending={actions.quota.isPending}
                error={actions.quota.error}
                onAnswer={(answer) =>
                  actions.quota.mutate({
                    stepId: item.stepId,
                    body: { answer, orchestrationRevision: run.revision },
                  })
                }
              />
            )
          case 'coding_limit':
            return (
              <CodingLimitCard
                key={`cl${item.stepId}`}
                arrivalKey={item.stepId}
                waiting={item.stepId}
                coding={coding ?? { codingSteps: 0 }}
                pending={actions.limits.isPending}
                error={actions.limits.error}
                onRaise={(codingSteps) =>
                  actions.limits.mutate({ orchestrationRevision: run.revision, codingSteps })
                }
              />
            )
          case 'paused':
            return (
              <Arrival
                arrivalId={`paused-${item.reason}`}
                key={`p${item.reason}`}
                data-protected="block"
                className="orch-decision"
                aria-label="Paused"
              >
                <h3>{needsYouText(item)}</h3>
              </Arrival>
            )
          case 'fence':
            return (
              <Arrival
                arrivalId={'fence'}
                key="fence"
                data-protected="block"
                className="orch-decision"
                aria-label="Blocked"
              >
                <h3>{needsYouText(item)}</h3>
                <p>Review the list on Now to lift the block.</p>
              </Arrival>
            )
        }
      })}
    </div>
  )
}

/** 3.7.12: why an attempt isn't confirmed as ended, in plain words. */
function unknownReasonText(reason: string | null | undefined): string {
  switch (reason) {
    case 'run_cancelled':
      return 'the run was cancelled'
    case 'run_interrupted':
      return 'the run was interrupted'
    case 'recovered_text_only':
      return 'only its text came back'
    case 'crash_after_send_started':
      return 'Score restarted while sending it'
    case 'run_not_proven_ended':
      return 'its end isn’t proven'
    case null:
    case undefined:
      return 'no reason recorded'
    default:
      return reason.replaceAll('_', ' ')
  }
}
