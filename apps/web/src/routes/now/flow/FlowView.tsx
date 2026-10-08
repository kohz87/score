import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import type { BriefStatus, BriefSummary } from '@score/contract'
import { useStreamQuery } from '../../../data/query-client.ts'
import { taskAgentsQuery, taskRoomsQuery } from '../../tasks/task-queries.ts'
import { FlowInspector } from './FlowInspector.tsx'
import { FlowLog, FlowStats } from './FlowLog.tsx'
import { FlowCanvas } from './FlowCanvas.tsx'
import { useBriefFlow, useBriefLists, useBriefRunControl } from './flow-queries.ts'
import './flow.css'

const statusLabel: Record<BriefStatus, string> = {
  running: 'Running',
  paused: 'Paused',
  done: 'Done',
  failed: 'Failed',
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

function RunControl({ brief }: { brief: BriefSummary }) {
  const control = useBriefRunControl(brief.id)
  if (brief.status !== 'running' && brief.status !== 'paused') return null
  const paused = brief.status === 'paused'
  return (
    <button
      type="button"
      className="flow-run-button"
      disabled={control.isPending}
      onClick={() => control.mutate(paused ? 'resume' : 'pause')}
    >
      {paused ? 'Resume run' : 'Pause run'}
    </button>
  )
}

export type FlowViewProps = { onSelect?: (nodeId: string | null) => void }

export function FlowView({ onSelect }: FlowViewProps = {}) {
  const { briefId: routeBriefId } = useParams()
  const navigate = useNavigate()
  const { active, recent } = useBriefLists()
  const agents = useStreamQuery(taskAgentsQuery)
  const rooms = useStreamQuery(taskRoomsQuery)
  const [selection, setSelection] = useState<{ briefId: string; nodeId: string } | null>(null)

  const activeItems = active.data ?? []
  const recentItems = (recent.data ?? []).filter(
    (item) => !activeItems.some((other) => other.id === item.id),
  )
  const briefId = routeBriefId ?? activeItems[0]?.id ?? recentItems[0]?.id
  const flow = useBriefFlow(briefId)

  const selectedId =
    selection &&
    selection.briefId === briefId &&
    flow.data?.nodes.some((node) => node.id === selection.nodeId)
      ? selection.nodeId
      : (flow.data?.nodes.find((node) => node.state === 'needs_you')?.id ??
        flow.data?.nodes.find((node) => node.kind === 'step')?.id ??
        null)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const select = (nodeId: string) => {
    if (briefId) setSelection({ briefId, nodeId })
    onSelect?.(nodeId)
  }

  const listsLoading = active.isPending || recent.isPending
  if (!briefId) {
    return (
      <div className="flow-view">
        <h2>Flow</h2>
        {listsLoading ? (
          <p role="status">Loading runs...</p>
        ) : (
          <p className="flow-empty">
            No runs yet. Send a message to a room and the work it causes shows up here.
          </p>
        )}
      </div>
    )
  }

  const brief = flow.data?.brief
  const room = rooms.data?.find((item) => item.id === brief?.roomId)
  return (
    <div className="flow-view">
      <section className="flow-heading" aria-label="Run">
        <div className="flow-heading__title">
          {brief && (
            <span className="flow-heading__meta">
              Run in {room?.name ?? brief.roomId}, started {clock(brief.startedAt)} by{' '}
              {brief.startedBy}
            </span>
          )}
          <h2>{brief?.title ?? 'Flow'}</h2>
          {flow.data?.notice && <p className="flow-notice">{flow.data.notice}</p>}
        </div>
        <div className="flow-heading__controls">
          {(activeItems.length > 0 || recentItems.length > 0) && (
            <select
              className="flow-picker"
              aria-label="Run"
              value={briefId}
              onChange={(event) => void navigate(`/now/flow/${event.target.value}`)}
            >
              {activeItems.length > 0 && (
                <optgroup label="Active">
                  {activeItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                </optgroup>
              )}
              {recentItems.length > 0 && (
                <optgroup label="Recent">
                  {recentItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                </optgroup>
              )}
              {!activeItems.some((i) => i.id === briefId) &&
                !recentItems.some((i) => i.id === briefId) && (
                  <option value={briefId}>{brief?.title ?? briefId}</option>
                )}
            </select>
          )}
          {brief && (
            <>
              <span className={`flow-status flow-status--${brief.status}`}>
                {statusLabel[brief.status]}
              </span>
              <RunControl brief={brief} />
            </>
          )}
        </div>
      </section>
      {flow.isError ? (
        <p role="alert" className="flow-empty">
          This run could not load.{' '}
          <button type="button" onClick={() => void flow.refetch()}>
            Try again
          </button>
        </p>
      ) : !flow.data ? (
        <p role="status" className="flow-empty">
          Loading the flow...
        </p>
      ) : (
        <div className="flow-main">
          <section className="flow-panel" aria-label="Flow of work">
            <FlowCanvas
              key={flow.data.brief.id}
              nodes={flow.data.nodes}
              edges={flow.data.edges}
              agents={agents.data ?? []}
              selectedId={selectedId}
              onSelect={select}
            />
          </section>
          <FlowInspector
            key={briefId}
            briefId={briefId}
            nodeId={selectedId}
            roomId={flow.data.brief.roomId}
            agents={agents.data ?? []}
            now={now}
          />
        </div>
      )}
      {flow.data && (
        <div className="flow-bottom">
          <FlowLog key={briefId} briefId={briefId} agents={agents.data ?? []} />
          <FlowStats stats={flow.data.stats} />
        </div>
      )}
    </div>
  )
}
