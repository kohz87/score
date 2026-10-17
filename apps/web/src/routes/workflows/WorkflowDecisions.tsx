import { Arrival } from '../../motion/Arrival.tsx'
import type { AgentSummary, WorkflowNeedsYou, WorkflowRunDetail } from '@score/contract'
import { useCallback, useMemo, useState } from 'react'
import { pauseReasonText } from '../orchestrations/orch-model.ts'
import {
  AgentChip,
  CancelFenceCard,
  ErrorLine,
  GateCard,
  LimitsCard,
  UnknownCard,
} from '../orchestrations/RunDecisions.tsx'
import type { WorkflowRunActions } from './workflow-queries.ts'
import { fetchWorkflowPreflight } from './workflow-queries.ts'
import {
  CodingAgentChangedCard,
  CodingHeldBackCard,
  InputsWithdrawnCard,
  QuotaHeldCard,
  WorkflowCodingLimitCard,
} from './WorkflowCodingCards.tsx'
import type { PreflightWorker } from '../orchestrations/CodingCards.tsx'
import { gateChip } from '../../live/resolved.ts'
import { ResolvedList } from '../../live/ResolvedList.tsx'
import { useRecentlyResolved } from '../../live/use-recently-resolved.ts'

// The decisions a workflow run asks of the person (contract §15). Each one carries the revision the page showed: the
// run's, plus the node's or gate's own where it names one. A stale page is answered with `409 conflict` and the run is
// read again; nothing is decided on a guess. The cards the orchestration pages already have are reused as they are.

type Actions = WorkflowRunActions

const labelOf = (run: Pick<WorkflowRunDetail, 'definition'>, nodeId: string): string =>
  run.definition.nodes.find((node) => node.id === nodeId)?.label ?? nodeId

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

/** A step that was given up on: Retry it (tries left), or stop the run. */
export function RetryCard({
  run,
  nodeId,
  attemptsLeft,
  actions,
}: {
  run: WorkflowRunDetail
  nodeId: string
  attemptsLeft: number
  actions: Pick<Actions, 'retry' | 'stop'>
}) {
  const [sure, setSure] = useState(false)
  const view = run.nodeStates.find((item) => item.nodeId === nodeId)
  const label = labelOf(run, nodeId)
  return (
    <Arrival
      arrivalId={`retry-${nodeId}-${attemptsLeft}`}
      className="orch-decision"
      aria-label={`Retry ${label}`}
    >
      <h3>You stopped waiting for {label}</h3>
      <p>
        You stopped waiting for its try, so the step has no result and nothing after it can start.
        Retry runs it again as a new try ({attemptsLeft} {attemptsLeft === 1 ? 'try' : 'tries'}{' '}
        left), or stop the run.
      </p>
      {attemptsLeft > 0 ? (
        <label className="orch-check">
          <input
            type="checkbox"
            checked={sure}
            onChange={(event) => setSure(event.target.checked)}
          />
          The earlier try may still be running. Score keeps trying to stop it and ignores its late
          result.
        </label>
      ) : (
        <p className="orch-muted">No tries are left for this step.</p>
      )}
      <div className="orch-actions">
        {attemptsLeft > 0 && view && (
          <button
            type="button"
            className="orch-primary"
            disabled={!sure || actions.retry.isPending}
            onClick={() =>
              actions.retry.mutate({
                nodeId,
                body: {
                  expectedNodeRevision: view.revision,
                  orchestrationRevision: run.revision,
                  acknowledge: true,
                },
              })
            }
          >
            Retry {label}
          </button>
        )}
        <button
          type="button"
          disabled={actions.stop.isPending}
          onClick={() => actions.stop.mutate({ orchestrationRevision: run.revision })}
        >
          Stop the run
        </button>
      </div>
      <ErrorLine error={actions.retry.error ?? actions.stop.error} />
    </Arrival>
  )
}

/** Hermes refused a step over and over: Score stopped trying on its own. */
export function RefusalCard({
  run,
  nodeId,
  refusals,
  actions,
}: {
  run: WorkflowRunDetail
  nodeId: string
  refusals: number
  actions: Pick<Actions, 'tryAgain' | 'stop'>
}) {
  const view = run.nodeStates.find((item) => item.nodeId === nodeId)
  const label = labelOf(run, nodeId)
  return (
    <Arrival
      arrivalId={`refused-${nodeId}-${refusals}`}
      className="orch-decision"
      aria-label={`Hermes refused ${label}`}
    >
      <h3>Hermes has refused this step {refusals} times</h3>
      <p>
        {label} hasn’t started: Hermes turned the request away each time, so nothing ran. Score
        stopped asking. Try again keeps the same step and asks Hermes once more, or you can stop the
        run.
      </p>
      <div className="orch-actions">
        {view && (
          <button
            type="button"
            className="orch-primary"
            disabled={actions.tryAgain.isPending}
            onClick={() =>
              actions.tryAgain.mutate({
                nodeId,
                body: {
                  expectedNodeRevision: view.revision,
                  orchestrationRevision: run.revision,
                },
              })
            }
          >
            Try again
          </button>
        )}
        <button
          type="button"
          disabled={actions.stop.isPending}
          onClick={() => actions.stop.mutate({ orchestrationRevision: run.revision })}
        >
          Stop the run
        </button>
      </div>
      <ErrorLine error={actions.tryAgain.error ?? actions.stop.error} />
    </Arrival>
  )
}

/** An agent was replaced after the run started. The exact plan of what would be re-created is shown and approved. */
export function WorkflowRemapCard({
  run,
  item,
  agents,
  actions,
}: {
  run: WorkflowRunDetail
  item: Extract<WorkflowNeedsYou, { kind: 'remap' }>
  agents: AgentSummary[]
  actions: Pick<Actions, 'remap' | 'stop'>
}) {
  const gone = item.currentIncarnation === 'untracked'
  const everyStep = run.gatePolicy === 'every-step'
  return (
    <Arrival
      arrivalId={`remap-${item.agentId}`}
      className="orch-decision"
      aria-label={`Replaced ${item.agentId}`}
    >
      <h3>
        <AgentChip agentId={item.agentId} agents={agents} /> was replaced
      </h3>
      <p>
        {gone
          ? 'This agent no longer exists, so its steps can’t run. You can stop the run.'
          : 'This run was started with the earlier agent. Its steps stay blocked until you decide.'}
      </p>
      <dl className="orch-facts">
        <dt>Steps affected</dt>
        <dd>{item.nodeIds.map((id) => labelOf(run, id)).join(', ') || 'None yet'}</dd>
        {!gone && (
          <>
            <dt>Agent at start</dt>
            <dd className="orch-mono">{item.frozenIncarnation}</dd>
            <dt>Agent now</dt>
            <dd className="orch-mono">{item.currentIncarnation}</dd>
          </>
        )}
      </dl>
      {!gone && item.plan.length > 0 && (
        <>
          <p>
            Steps that were never sent are dropped and created again for the new agent, with exactly
            this text.{' '}
            {everyStep ? 'Each one asks you again.' : 'Your decision here is the approval.'} Work
            that may already have been sent keeps going. The change applies to later work.
          </p>
          <ul className="wf-evidence" aria-label="What would be created again">
            {item.plan.map((entry) => (
              <li key={entry.nodeId}>
                <details>
                  <summary>
                    {labelOf(run, entry.nodeId)}{' '}
                    <span className="orch-mono orch-muted">{entry.payloadHash.slice(0, 10)}</span>
                  </summary>
                  <pre className="orch-pre">{entry.payload}</pre>
                </details>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="orch-actions">
        {!gone && (
          <button
            type="button"
            className="orch-primary"
            disabled={actions.remap.isPending}
            onClick={() =>
              actions.remap.mutate({
                agentId: item.agentId,
                frozenIncarnation: item.frozenIncarnation,
                currentIncarnation: item.currentIncarnation,
                orchestrationRevision: run.revision,
                acknowledge: true,
                plan: item.plan.map(({ nodeId, payloadHash }) => ({ nodeId, payloadHash })),
              })
            }
          >
            Use the new {item.agentId} for this run
          </button>
        )}
        <button
          type="button"
          disabled={actions.stop.isPending}
          onClick={() => actions.stop.mutate({ orchestrationRevision: run.revision })}
        >
          Stop the run
        </button>
      </div>
      <ErrorLine error={actions.remap.error ?? actions.stop.error} />
    </Arrival>
  )
}

/** Every item the run needs from the person, in the order the server lists them. */
export function WorkflowNeeds({
  run,
  agents,
  actions,
}: {
  run: WorkflowRunDetail
  agents: AgentSummary[]
  actions: Actions
}) {
  // The shared cards read a run through these narrow shapes; a workflow supplies them from its own view.
  const gateRun = useMemo(
    () => ({ gates: run.assignmentGates, stepsList: run.steps, revision: run.revision }),
    [run.assignmentGates, run.steps, run.revision],
  )
  // The run's own check of a coding agent: the workflow's preflight, read for that one agent. No lead is involved.
  const { workflowId, version } = run
  const preflightWorker = useCallback<PreflightWorker>(
    async (agentId) =>
      (await fetchWorkflowPreflight(workflowId, version)).workers.find(
        (entry) => entry.agentId === agentId,
      ),
    [workflowId, version],
  )
  // Only a running or paused run can be decided on; while it stops or after it ended the server answers 409 not_open,
  // so only what winding down still needs (unconfirmed attempts, a cancelled step, the fence) is offered.
  const deciding = run.status === 'running' || run.status === 'paused'
  const items = run.needsYou.filter(
    (item) =>
      deciding || item.kind === 'unknown' || item.kind === 'cancel_fence' || item.kind === 'fence',
  )
  const openGates = new Set(
    items.flatMap((item) => (item.kind === 'gate' ? [`${item.gateKind}:${item.gateId}`] : [])),
  )
  // A decided gate stays where it was, as a chip, for a moment.
  const decided = useRecentlyResolved(openGates, (key) => {
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
    const gate = (kind === 'node' ? run.nodeGates : run.assignmentGates).find(
      (item) => item.id === id,
    )
    const chip = gate ? gateChip(gate) : null
    return gate && chip ? { label: labelOf(run, gate.nodeId), chip } : null
  })
  if (items.length === 0 && decided.length === 0) return null
  const unknownIds = new Set(
    items.flatMap((item) => (item.kind === 'unknown' ? [item.attemptId] : [])),
  )
  const fenceFor = (attemptId: string): { fenceStepId?: string } => {
    const fence = items.find((item) => item.kind === 'cancel_fence' && item.attemptId === attemptId)
    return fence?.kind === 'cancel_fence' ? { fenceStepId: fence.stepId } : {}
  }
  return (
    <div className="orch-needs" aria-label="Needs you">
      <ResolvedList items={decided} />
      {items.map((item) => {
        switch (item.kind) {
          case 'gate':
            return item.gateKind === 'node' ? (
              <NodeGateCard
                key={`g${item.gateId}`}
                run={run}
                gateId={item.gateId}
                actions={actions}
              />
            ) : (
              <GateCard
                key={`a${item.gateId}`}
                run={gateRun}
                gateId={item.gateId}
                agents={agents}
                actions={actions}
                label={labelOf(run, item.nodeId)}
              />
            )
          case 'budget':
            return (
              <LimitsCard
                key={`b${item.reason}`}
                run={run}
                coding={run.coding}
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
                {...(item.nodeId ? { label: labelOf(run, item.nodeId) } : {})}
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
          case 'retry':
            return (
              <RetryCard
                key={`r${item.nodeId}`}
                run={run}
                nodeId={item.nodeId}
                attemptsLeft={item.attemptsLeft}
                actions={actions}
              />
            )
          case 'refusal_limit':
            return (
              <RefusalCard
                key={`f${item.attemptId}`}
                run={run}
                nodeId={item.nodeId}
                refusals={item.refusals}
                actions={actions}
              />
            )
          case 'remap':
            return (
              <WorkflowRemapCard
                key={`m${item.agentId}`}
                run={run}
                item={item}
                agents={agents}
                actions={actions}
              />
            )
          case 'coding_agent_changed':
            return (
              <CodingAgentChangedCard
                key={`cc${item.nodeId}`}
                run={run}
                item={item}
                agents={agents}
                preflightWorker={preflightWorker}
                actions={actions}
              />
            )
          case 'quota_low':
            return (
              <QuotaHeldCard
                key={`ql${item.nodeId}`}
                run={run}
                item={item}
                agents={agents}
                actions={actions}
              />
            )
          case 'coding_limit':
            return <WorkflowCodingLimitCard key="cl" run={run} actions={actions} />
          case 'coding_held_back':
            return (
              <CodingHeldBackCard
                key={`hb${item.nodeId}`}
                run={run}
                nodeId={item.nodeId}
                actions={actions}
              />
            )
          case 'node_inputs_withdrawn':
            return (
              <InputsWithdrawnCard
                key={`iw${item.nodeId}`}
                run={run}
                nodeId={item.nodeId}
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
                <h3>{pauseReasonText(item.reason)}</h3>
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
                <h3>Starting work is blocked until you review a list</h3>
                <p>Review the list on Now to lift the block.</p>
              </Arrival>
            )
        }
      })}
    </div>
  )
}
