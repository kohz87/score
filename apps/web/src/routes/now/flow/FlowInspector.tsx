import type { AgentSummary, FlowNodeDetail } from '@score/contract'
import { Link } from 'react-router'
import { AgentGlyph } from '../../../components/AgentGlyph.tsx'
import { ApiError } from '../../../data/api.ts'
import { ApprovalCard } from '../../chat/ApprovalCard.tsx'
import { agentTextColor } from '../../chat/agent-text-color.ts'
import { useFlowNode, useStopFlowNode } from './flow-queries.ts'
import '../../chat/chat.css'

export function duration(seconds: number): string {
  return seconds < 60 ? `${Math.floor(seconds)} sec` : `${Math.floor(seconds / 60)} min`
}

const stateText = {
  done: 'Done',
  working: 'Working',
  planned: 'Planned',
  failed: 'Failed',
  needs_you: 'Waiting on you',
}

function StepDetail({
  detail,
  briefId,
  roomId,
  agents,
  now,
}: {
  detail: FlowNodeDetail
  briefId: string
  roomId: string
  agents: AgentSummary[]
  now: number
}) {
  const { node, run, approval } = detail
  const agent = agents.find((item) => item.id === node.agentId)
  const stop = useStopFlowNode(briefId, node.id)
  const stoppable = run && ['queued', 'running', 'waiting_for_approval'].includes(run.status)
  const runningSec = run
    ? Math.max(
        0,
        (Date.parse(run.endedAt ?? new Date(now).toISOString()) - Date.parse(run.startedAt)) / 1000,
      )
    : null
  return (
    <>
      <div className="flow-inspector__heading">
        {node.agentId && (
          <AgentGlyph
            agent={
              agent ?? {
                id: node.agentId,
                name: node.agentId,
                style: { color: '#9AA0AB', shape: 'circle-dot' },
              }
            }
            size="lg"
          />
        )}
        <div>
          <h2>{node.title}</h2>
          {node.agentId && (
            <span style={{ color: agentTextColor(agent?.style.color ?? '#9AA0AB') }}>
              {agent?.name ?? node.agentId}
            </span>
          )}
        </div>
      </div>
      <p className="flow-inspector__state" role="status">
        {approval
          ? `Waiting on you for ${duration(Math.max(0, (now - Date.parse(approval.createdAt)) / 1000))}`
          : stateText[node.state]}
      </p>
      {detail.description && <p className="flow-inspector__description">{detail.description}</p>}
      {detail.steps.length > 0 && (
        <ul className="flow-steps" aria-label="Steps">
          {detail.steps.map((step) => (
            <li key={step.id} className={step.done ? 'flow-step--done' : ''}>
              <span className="flow-step__mark" aria-hidden="true">
                {step.done ? '✓' : ''}
              </span>
              <span className="flow-sr-only">{step.done ? 'Completed: ' : 'Pending: '}</span>
              {step.text}
            </li>
          ))}
        </ul>
      )}
      {run && run.gaps.length > 0 && (
        <p className="flow-inspector__state" role="status">
          Some events from this step were not recorded ({run.gaps.length} gap
          {run.gaps.length === 1 ? '' : 's'}).
        </p>
      )}
      {approval && <ApprovalCard key={approval.id} approvalId={approval.id} />}
      {detail.watch ? (
        <Link
          className="flow-watch flow-watch--link"
          to={`/now/watch/${encodeURIComponent(detail.watch.agentId)}`}
        >
          <span className="flow-watch__screen" aria-hidden="true">
            {detail.watch.thumbnail ? (
              <img src={detail.watch.thumbnail} alt="" />
            ) : (
              <span>{detail.watch.front}</span>
            )}
          </span>
          <span>Watch {agent?.name ?? detail.watch.agentId} work</span>
        </Link>
      ) : (
        <div className="flow-watch">No desktop open for this step</div>
      )}
      <dl className="flow-inspector__facts">
        <div>
          <dt>Model</dt>
          <dd>{detail.model ?? '—'}</dd>
        </div>
        <div>
          <dt>Running for</dt>
          <dd>{runningSec === null ? '—' : duration(runningSec)}</dd>
        </div>
        <div>
          <dt>Tools used</dt>
          <dd>{detail.tools.join(', ') || '—'}</dd>
        </div>
      </dl>
      <div className="flow-inspector__actions">
        <Link to={`/chat/${encodeURIComponent(roomId)}`}>Open in Chat</Link>
        <button
          type="button"
          disabled={!stoppable || stop.isPending || stop.isSuccess}
          onClick={() => stop.mutate()}
        >
          {stop.isPending ? 'Stopping…' : stop.isSuccess ? 'Stopped' : 'Stop this step'}
        </button>
      </div>
      {stop.isError && (
        <p role="alert">
          {stop.error instanceof ApiError
            ? stop.error.message
            : 'Could not stop this step. Try again.'}
        </p>
      )}
    </>
  )
}

export function FlowInspector({
  briefId,
  nodeId,
  roomId,
  agents,
  now,
}: {
  briefId: string
  nodeId: string | null
  roomId: string
  agents: AgentSummary[]
  now: number
}) {
  const detail = useFlowNode(briefId, nodeId)
  return (
    <aside className="flow-inspector" aria-label="Selected step">
      {!nodeId ? (
        <p>Select a step to see its details.</p>
      ) : detail.isError ? (
        <p role="alert">
          This step could not load.{' '}
          <button type="button" onClick={() => void detail.refetch()}>
            Try again
          </button>
        </p>
      ) : !detail.data ? (
        <p role="status">Loading step…</p>
      ) : (
        <StepDetail
          key={nodeId}
          detail={detail.data}
          briefId={briefId}
          roomId={roomId}
          agents={agents}
          now={now}
        />
      )}
    </aside>
  )
}
