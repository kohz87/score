import { Arrival } from '../../motion/Arrival.tsx'
import { gateChip } from '../../live/resolved.ts'
import { ResolvedList } from '../../live/ResolvedList.tsx'
import { useRecentlyResolved } from '../../live/use-recently-resolved.ts'
import type { AgentSummary, NeedsYou, OrchestrationDetail } from '@score/contract'
import { useState } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { needsYouText, usd } from './orch-model.ts'
import {
  describeOrchError,
  type DecisionActions,
  type RunActions,
} from './orchestration-queries.ts'

// The decisions a run asks of the person, each bound to the revision the page showed (contract §14). A stale page
// is answered with `409 conflict`: the run is read again and the person decides again.

export function AgentChip({ agentId, agents }: { agentId: string; agents: AgentSummary[] }) {
  const agent = agents.find((item) => item.id === agentId)
  return (
    <span className="orch-agent">
      {agent && <AgentGlyph agent={agent} size="xs" describeShape />}
      <span>{agent?.name ?? agentId}</span>
    </span>
  )
}

export function ErrorLine({ error }: { error: unknown }) {
  return error ? (
    <p role="alert" className="orch-error">
      {describeOrchError(error)}
    </p>
  ) : null
}

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
  reason,
  actions,
}: {
  run: LimitsRun
  reason: Extract<NeedsYou, { kind: 'budget' }>['reason']
  actions: Pick<DecisionActions, 'limits'>
}) {
  const [budget, setBudget] = useState('')
  const [deadline, setDeadline] = useState('')
  const apply = () => {
    const raised = Number(budget)
    actions.limits.mutate({
      orchestrationRevision: run.revision,
      ...(budget !== '' && raised > 0 ? { budgetUsd: raised } : {}),
      ...(deadline !== '' ? { deadlineAt: new Date(deadline).toISOString() } : {}),
    })
  }
  return (
    <Arrival
      arrivalId={`limits-${reason}`}
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
      </div>
      <div className="orch-actions">
        <button
          type="button"
          className="orch-primary"
          disabled={actions.limits.isPending || (budget === '' && deadline === '')}
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
      className="orch-decision"
      aria-label="Not confirmed as ended"
    >
      <h3>Not confirmed as ended: {label ?? attempt.stepId ?? 'lead turn'}</h3>
      <p>
        Hermes hasn’t said this work finished (
        {attempt.unknownReason?.replaceAll('_', ' ') ?? 'no reason recorded'}). Score keeps trying
        to stop it. Until it ends, nothing new starts.
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
    <div className="orch-needs" aria-label="Needs you">
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
          case 'paused':
            return (
              <Arrival
                arrivalId={`paused-${item.reason}`}
                key={`p${item.reason}`}
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
