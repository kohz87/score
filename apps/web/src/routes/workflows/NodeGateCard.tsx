import { Arrival } from '../../motion/Arrival.tsx'
import type { WorkflowRunDetail } from '@score/contract'
import { useState } from 'react'
import { ErrorLine } from '../orchestrations/RunDecisions.tsx'
import { labelOf, type Actions } from './workflow-decision-model.ts'

/** The node's gate: the question and the results it was shown, frozen when it opened. */
export function NodeGateCard({
  run,
  gateId,
  actions,
}: {
  run: WorkflowRunDetail
  gateId: string
  actions: Pick<Actions, 'gate'>
}) {
  const gate = run.nodeGates.find((item) => item.id === gateId)
  const [note, setNote] = useState('')
  if (!gate) return null
  const node = run.definition.nodes.find((item) => item.id === gate.nodeId)
  const label = labelOf(run, gate.nodeId)
  const rejectStops = node?.kind === 'gate' && node.onReject === 'stop_run'
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
      aria-label={`Decide on ${label}`}
    >
      <h3>
        {label}
        <small> The run is waiting for you</small>
      </h3>
      <p className="orch-quote">{gate.payload.question}</p>
      <p className="orch-gate-lead">
        This is what the gate showed when it opened. If anything changed since, it would ask again.
      </p>
      {gate.payload.consumed.length === 0 ? (
        <p className="orch-muted">Nothing from earlier steps is attached to this question.</p>
      ) : (
        <ul className="wf-evidence" aria-label="Results this question is about">
          {gate.payload.consumed.map((item) => (
            <li key={item.nodeId}>
              <details>
                <summary>
                  {labelOf(run, item.nodeId)}{' '}
                  <span className="orch-muted">result version {item.outputRevision}</span>
                  {item.truncated ? <span className="orch-muted"> (shortened)</span> : null}
                </summary>
                <pre className="orch-pre">{item.output}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
      <label className="orch-field">
        <span>Note (optional)</span>
        <input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className="orch-actions">
        <button
          type="button"
          className="orch-primary"
          disabled={actions.gate.isPending}
          onClick={() => decide('approve')}
        >
          Approve
        </button>
        <button type="button" disabled={actions.gate.isPending} onClick={() => decide('reject')}>
          Reject
        </button>
        <span className="orch-muted">
          {rejectStops
            ? 'Rejecting stops the run.'
            : 'Rejecting sends the run down the “rejected” path.'}
        </span>
      </div>
      <ErrorLine error={actions.gate.error} />
    </Arrival>
  )
}
