import type { AgentSummary, OrchestrationDetail } from '@score/contract'
import { useState } from 'react'
import { Arrival } from '../../motion/Arrival.tsx'
import { AgentChip, ErrorLine } from './decision-parts.tsx'
import { usd } from './orch-model.ts'
import type { DecisionActions, RunActions } from './orchestration-queries.ts'
import type { GateRun } from './run-decision-types.ts'

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
