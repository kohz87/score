import type { AgentSummary, NeedsYou, OrchestrationDetail } from '@score/contract'
import { useState } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { needsYouText, usd } from './orch-model.ts'
import { describeOrchError, type RunActions } from './orchestration-queries.ts'

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

function ErrorLine({ error }: { error: unknown }) {
  return error ? (
    <p role="alert" className="orch-error">
      {describeOrchError(error)}
    </p>
  ) : null
}

export function GateCard({
  run,
  gateId,
  agents,
  actions,
}: {
  run: OrchestrationDetail
  gateId: string
  agents: AgentSummary[]
  actions: RunActions
}) {
  const gate = run.gates.find((item) => item.id === gateId)
  const [note, setNote] = useState('')
  if (!gate) return null
  const replaced = gate.payload.replaces
    ? run.stepsList.find((step) => step.id === gate.payload.replaces)
    : undefined
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
    <section className="orch-decision orch-decision--gate" aria-label={`Approve ${gate.stepId}`}>
      <h3>
        Approve {gate.stepId}?{' '}
        <small>{gate.requestedBy === 'lead' ? 'The lead asked' : 'Your gate policy asks'}</small>
      </h3>
      <p className="orch-gate-lead">
        Approving lets exactly this assignment start. It is frozen; if the lead changes its mind it
        has to ask again.
      </p>
      <dl className="orch-facts">
        <dt>Agent</dt>
        <dd>
          <AgentChip agentId={gate.payload.agentId} agents={agents} />{' '}
          <span
            className="orch-mono"
            title="The agent as it is now; a changed agent blocks the step"
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
                    `${id} (result v${gate.payload.dependencyRevisions[id] ?? 0}, ${run.stepsList.find((step) => step.id === id)?.status ?? 'unknown'})`,
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
              . If it was admitted, the new step may only start once the old one has ended.
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
          Approve {gate.stepId}
        </button>
        <button type="button" disabled={actions.gate.isPending} onClick={() => decide('reject')}>
          Reject
        </button>
      </div>
      <ErrorLine error={actions.gate.error} />
    </section>
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
    <section className="orch-decision orch-decision--inquiry" aria-label="Question from the lead">
      <h3>The lead asks</h3>
      <p className="orch-quote">{inquiry.question}</p>
      <label className="orch-field">
        <span>Your answer (the lead reads it as data; it never changes permissions)</span>
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
    </section>
  )
}

export function LimitsCard({
  run,
  reason,
  actions,
}: {
  run: OrchestrationDetail
  reason: Extract<NeedsYou, { kind: 'budget' }>['reason']
  actions: RunActions
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
    <section className="orch-decision" aria-label="Budget or deadline">
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
    </section>
  )
}

export function UnknownCard({
  run,
  attemptId,
  actions,
}: {
  run: OrchestrationDetail
  attemptId: string
  actions: RunActions
}) {
  const attempt = run.attempts.find((item) => item.id === attemptId)
  const [sure, setSure] = useState(false)
  if (!attempt) return null
  return (
    <section className="orch-decision" aria-label="Attempt not confirmed ended">
      <h3>Not confirmed ended: {attempt.stepId ?? 'lead turn'}</h3>
      <p>
        Hermes has not said this run finished ({attempt.unknownReason ?? 'no reason recorded'}).
        Score keeps trying to stop it. Until it ends, nothing new starts.
      </p>
      <label className="orch-check">
        <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
        These may still be running; Score will keep trying to stop them and will ignore their late
        results.
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
          Abandon this attempt
        </button>
      </div>
      <ErrorLine error={actions.abandon.error} />
    </section>
  )
}

export function CancelFenceCard({
  run,
  stepId,
  actions,
}: {
  run: OrchestrationDetail
  stepId: string
  actions: RunActions
}) {
  const [sure, setSure] = useState(false)
  return (
    <section className="orch-decision" aria-label="Cancelled step may still run">
      <h3>Cancelled {stepId} may still be running</h3>
      <p>
        Nothing new starts until it has ended. You can also continue while it may still run; that is
        recorded and is not proof that it stopped.
      </p>
      <label className="orch-check">
        <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
        Continue while the cancelled step may still run.
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
    </section>
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
  if (run.needsYou.length === 0) return null
  return (
    <div className="orch-needs" aria-label="Needs you">
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
              />
            )
          case 'cancel_fence':
            return (
              <CancelFenceCard
                key={`c${item.attemptId}`}
                run={run}
                stepId={item.stepId}
                actions={actions}
              />
            )
          case 'paused':
            return (
              <section key={`p${item.reason}`} className="orch-decision" aria-label="Paused">
                <h3>{needsYouText(item)}</h3>
              </section>
            )
          case 'fence':
            return (
              <section key="fence" className="orch-decision" aria-label="Blocked">
                <h3>{needsYouText(item)}</h3>
                <p>Open the reconciliation list on Now to review it.</p>
              </section>
            )
        }
      })}
    </div>
  )
}
