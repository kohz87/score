import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { useStreamQuery } from '../../data/query-client.ts'
import { ApiError } from '../../data/api.ts'
import { roomsQuery } from '../chat/queries.ts'
import { Composer } from '../chat/Composer.tsx'
import { FlowInspector } from '../now/flow/FlowInspector.tsx'
import { useFlowNode, useStopFlowNode } from '../now/flow/flow-queries.ts'
import { useNow } from '../now/now-queries.ts'
import { ScoreTimeline } from '../now/ScoreTimeline.tsx'
import { taskAgentsQuery } from '../tasks/task-queries.ts'
import { useAgentStep } from './pop-queries.ts'
import '../now/now.css'
import '../now/flow/flow.css'
import './pop.css'

function StopButton({ briefId, nodeId }: { briefId: string; nodeId: string }) {
  const detail = useFlowNode(briefId, nodeId)
  const stop = useStopFlowNode(briefId, nodeId)
  const run = detail.data?.run
  const stoppable = Boolean(
    run && ['queued', 'running', 'waiting_for_approval'].includes(run.status),
  )
  return (
    <>
      <button
        type="button"
        className="pop-stop"
        disabled={!stoppable || stop.isPending}
        onClick={() => stop.mutate()}
      >
        {stop.isPending ? 'Stopping…' : 'Stop'}
      </button>
      {stop.isError && (
        <p role="alert" className="pop-error">
          {stop.error instanceof ApiError
            ? stop.error.message
            : 'Could not stop this step. Try again.'}
        </p>
      )}
    </>
  )
}

/** One agent's live view in a small window: its lane, the step it is on, a message box and Stop. */
export function PopOutPage() {
  const { agentId = '' } = useParams()
  const agents = useStreamQuery(taskAgentsQuery)
  const rooms = useStreamQuery(roomsQuery)
  const now = useNow()
  const { step, loading } = useAgentStep(agentId)
  const [tick, setTick] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const agent = agents.data?.find((item) => item.id === agentId)
  const lane = now.data?.lanes.find((item) => item.agent.id === agentId)
  const direct = rooms.data?.directs.find((room) => room.leadAgentId === agentId)
  useEffect(() => {
    document.title = `${agent?.name ?? 'Agent'} · Score`
  }, [agent?.name])

  if (agents.data && !agent)
    return (
      <main className="pop" aria-label="Agent window">
        <p role="alert">
          There is no agent called {agentId}. <Link to="/team">Open Team</Link>
        </p>
      </main>
    )
  return (
    <main className="pop" aria-label={`${agent?.name ?? agentId}, live view`}>
      <header className="pop-header">
        {agent && <AgentGlyph agent={agent} size="lg" />}
        <div className="pop-header__text">
          <h1>{agent?.name ?? agentId}</h1>
          <span className="pop-header__status" aria-live="polite">
            {agent
              ? (agent.activity ?? (agent.status === 'working' ? 'Working' : 'Idle'))
              : 'Loading…'}
          </span>
        </div>
        {step && <StopButton key={step.nodeId} briefId={step.briefId} nodeId={step.nodeId} />}
        <Link className="pop-header__open" to={`/team/${encodeURIComponent(agentId)}`}>
          Open in Score
        </Link>
      </header>

      <section className="pop-section" aria-label="Now">
        {now.data && lane ? (
          <ScoreTimeline
            snapshot={{ ...now.data, lanes: [lane], handoffs: [], unattributed: undefined }}
          />
        ) : now.isError ? (
          <p role="alert">Could not load the score.</p>
        ) : (
          <p role="status">Loading the lane…</p>
        )}
      </section>

      <section className="pop-section" aria-label="Current run">
        {step ? (
          <FlowInspector
            key={step.nodeId}
            briefId={step.briefId}
            nodeId={step.nodeId}
            roomId={step.roomId}
            agents={agents.data ?? []}
            now={tick}
            showStop={false}
          />
        ) : (
          <p className="pop-empty" role="status">
            {loading
              ? 'Looking for a run…'
              : `${agent?.name ?? agentId} is not in a run right now.`}
          </p>
        )}
      </section>

      <section className="pop-section pop-chat" aria-label="Message">
        {direct && agent ? (
          <Composer
            key={direct.id}
            roomId={direct.id}
            roomName={direct.name}
            agents={[agent]}
            leadAgentId={agentId}
          />
        ) : (
          <p className="pop-empty" role="status">
            {rooms.data
              ? `No direct conversation with ${agent?.name ?? agentId} yet. Open one in Chat.`
              : 'Loading…'}
          </p>
        )}
      </section>
    </main>
  )
}
