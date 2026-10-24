import type { AgentSummary, NodeView, WorkflowRunDetail } from '@score/contract'
import { Link } from 'react-router'
import { stepVisual } from '../orchestrations/orch-model.ts'
import { AgentChip } from '../orchestrations/RunDecisions.tsx'
import { AttemptLine, StateMark } from '../orchestrations/RunPanel.tsx'
import { KIND_LABEL } from './workflow-model.ts'
import { nodeVisual, showsWaiting, waitingText } from './workflow-run-model.ts'

// The inspector of a run's node: its attempts, what it read (with the result revision), its verdict and its output.
// All of it comes from the server's snapshot of the run.

const clock = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString() : null)

export function WorkflowNodePanel({
  run,
  nodeId,
  agents,
}: {
  run: WorkflowRunDetail
  nodeId: string
  agents: AgentSummary[]
}) {
  const def = run.definition.nodes.find((node) => node.id === nodeId)
  const view: NodeView | undefined = run.nodeStates.find((node) => node.nodeId === nodeId)
  if (!def || !view) return null
  const visual = nodeVisual(view.state)
  const lineage = new Set(view.lineage)
  const attempts = run.attempts.filter((attempt) => attempt.stepId && lineage.has(attempt.stepId))
  const reads = run.consumed.filter((item) => item.consumer === nodeId)
  const label = (id: string) => run.definition.nodes.find((node) => node.id === id)?.label ?? id
  const step = run.steps.find((item) => item.id === view.stepId)
  const lastAttempt = attempts.at(-1)
  const effective = def.kind === 'agent' && step ? stepVisual(step, lastAttempt) : null
  return (
    <section className="orch-selected wf-node-panel" aria-label="Selected step">
      <h3>
        {def.label} <small className="orch-muted">{KIND_LABEL[def.kind]}</small>
      </h3>
      <dl className="orch-facts">
        {def.kind === 'agent' && (
          <>
            <dt>Agent</dt>
            <dd>
              <AgentChip agentId={def.agentId} agents={agents} />
            </dd>
          </>
        )}
        <dt>State</dt>
        <dd>
          <StateMark visual={visual} />
          {showsWaiting(view) ? ` ${waitingText[view.waitingFor]}` : ''}
          {effective === 'unknown' ? ' (a try isn’t confirmed as ended)' : ''}
        </dd>
        {def.kind === 'agent' && (
          <>
            <dt>Tries</dt>
            <dd>
              {view.attemptsUsed} of {view.attemptsMax} used
              {view.canRetry ? '; Retry is available' : ''}
            </dd>
          </>
        )}
        {view.reason && (
          <>
            <dt>Why</dt>
            <dd>{view.reason}</dd>
          </>
        )}
        {def.kind === 'gate' && (
          <>
            <dt>Question</dt>
            <dd>{def.question}</dd>
          </>
        )}
        {view.startedAt && (
          <>
            <dt>Started</dt>
            <dd>{clock(view.startedAt)}</dd>
          </>
        )}
        {view.endedAt && (
          <>
            <dt>Ended</dt>
            <dd>{clock(view.endedAt)}</dd>
          </>
        )}
      </dl>

      {def.kind === 'agent' && (
        <details>
          <summary>Instruction template</summary>
          <pre className="orch-pre">{def.instruction}</pre>
        </details>
      )}

      {reads.length > 0 && (
        <>
          <h4>It read</h4>
          <ul className="wf-reads" aria-label="Results this step read">
            {reads.map((item) => (
              <li key={`${item.consumerAttempt}-${item.producer}`}>
                {item.kind === 'default'
                  ? `A fallback text for ${label(item.producer)} (it never ran)`
                  : item.kind === 'failure'
                    ? `The failure of ${label(item.producer)}`
                    : `The output of ${label(item.producer)}`}
                {item.kind !== 'default' && (
                  <>
                    {' '}
                    (try {item.producerAttempt}, result version {item.outputRevision})
                  </>
                )}
                {!item.eligible && (
                  <strong className="orch-error"> withdrawn, no longer counted</strong>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {view.verdict && (
        <p>
          <strong>Verdict: {view.verdict.verdict.replace('_', ' ')}.</strong> {view.verdict.reason}{' '}
          <span className="orch-muted">
            Read from the agent’s complete reply
            {view.verdict.outputTruncated ? ' before the saved output was shortened' : ''}.
          </span>
        </p>
      )}

      {view.output !== null && (
        <details open>
          <summary>
            Output (result version {view.outputRevision})
            {view.outputTruncated ? ', shortened to fit' : ''}
          </summary>
          <pre className="orch-pre">{view.output}</pre>
        </details>
      )}

      {view.refusals && view.refusals.lifetime > 0 && (
        <p className="orch-muted">
          Hermes turned this step away {view.refusals.lifetime}{' '}
          {view.refusals.lifetime === 1 ? 'time' : 'times'} (nothing ran)
          {view.refusals.nextTryAt ? `; the next try is at ${clock(view.refusals.nextTryAt)}` : ''}.
        </p>
      )}

      {attempts.length > 0 && (
        <details>
          <summary>
            {attempts.length} {attempts.length === 1 ? 'try' : 'tries'} of this step
          </summary>
          <ul className="orch-attempts">
            {attempts.map((attempt) => (
              <AttemptLine key={attempt.id} attempt={attempt} />
            ))}
          </ul>
        </details>
      )}

      {def.kind === 'agent' && (
        <p className="orch-muted">
          <Link to={`/watch/${encodeURIComponent(def.agentId)}`}>Open the agent’s Watch</Link>{' '}
          (shows all the agent’s work, not just this step).
        </p>
      )}
    </section>
  )
}
