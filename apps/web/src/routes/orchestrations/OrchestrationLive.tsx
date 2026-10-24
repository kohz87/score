import type { OrchEvent, OrchestrationDetail } from '@score/contract'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { runtimeLabel } from '../../components/runtime-label.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { taskAgentsQuery } from '../../data/task-queries.ts'
import { LiveDiagram } from './LiveDiagram.tsx'
import { LiveLog } from './LiveLog.tsx'
import {
  buildGraph,
  eventEffect,
  filterLog,
  isRunOver,
  LEAD_NODE,
  orchCoding,
  replayAt,
  replayDelayMs,
  stepVisual,
  type NodeVisual,
} from './orch-model.ts'
import { useRun, useRunActions } from './orchestration-queries.ts'
import { ReplayBar } from './ReplayBar.tsx'
import { useRunPlayback } from './use-run-playback.ts'
import { useStatusLines } from '../../live/use-activity.ts'
import {
  BudgetBlock,
  EndSummary,
  FinishBlock,
  PlanList,
  RunControls,
  RunStatus,
  StepCard,
} from './RunPanel.tsx'
import { RunNeeds } from './RunDecisions.tsx'
import './orchestrations.css'

/** Visual of every step from the snapshot (the authority while the run is live). */
function liveVisuals(run: OrchestrationDetail): Map<string, NodeVisual> {
  return new Map(
    run.stepsList.map((step) => [
      step.id,
      stepVisual(
        step,
        run.attempts.findLast((attempt) => attempt.stepId === step.id),
      ),
    ]),
  )
}
const liveLead = (run: OrchestrationDetail): 'idle' | 'working' | 'ended' =>
  isRunOver(run.status)
    ? 'ended'
    : run.attempts.some(
          (attempt) =>
            attempt.kind === 'lead' &&
            ['created', 'send_started', 'running'].includes(attempt.state),
        )
      ? 'working'
      : 'idle'

/** The run as a live diagram with a log beside it; a finished run can be replayed from its event history. */
export function OrchestrationLive({ orchestrationId }: { orchestrationId: string }) {
  const run = useRun(orchestrationId)
  const agents = useStreamQuery(taskAgentsQuery).data ?? []
  const actions = useRunActions(orchestrationId)
  const [selected, setSelected] = useState<string | null>(null)
  const detail = run.data?.snapshot.orchestration
  const events: OrchEvent[] = useMemo(() => run.data?.events ?? [], [run.data])
  const known = useMemo(() => new Set(detail?.stepsList.map((step) => step.id)), [detail])
  const {
    replaying,
    count,
    playing,
    speed,
    quiet,
    player,
    setCount,
    setPlaying,
    setSpeed,
    toggleReplay,
  } = useRunPlayback({
    id: orchestrationId,
    loaded: run.data !== undefined,
    events,
    effectOf: (event) => eventEffect(event, known),
    delayMs: replayDelayMs,
  })

  const replay = useMemo(() => replayAt(events, count), [events, count])
  // What the working agents are doing, as the caption of their step (live only: a replay shows recorded events).
  const workingNow = useMemo(() => {
    if (!detail || isRunOver(detail.status)) return []
    const running = liveVisuals(detail)
    return [
      ...(liveLead(detail) === 'working' ? [{ id: detail.leadAgentId, working: true }] : []),
      ...detail.stepsList
        .filter((step) => running.get(step.id) === 'running')
        .map((step) => ({ id: step.agentId, working: true })),
    ]
  }, [detail])
  const lines = useStatusLines(workingNow)
  const graph = useMemo(() => {
    if (!detail) return { nodes: [], edges: [] }
    const built = buildGraph(detail)
    if (replaying || lines.size === 0) return built
    const running = liveVisuals(detail)
    return {
      ...built,
      nodes: built.nodes.map((node) => {
        const agentId = node.kind === 'lead' ? detail.leadAgentId : node.agentId
        const live =
          node.kind === 'lead' ? liveLead(detail) === 'working' : running.get(node.id) === 'running'
        const line = live ? lines.get(agentId) : undefined
        return line ? { ...node, status: line } : node
      }),
    }
  }, [detail, lines, replaying])
  if (run.isError)
    return (
      <p role="alert" className="orch-error">
        Couldn’t load this run.{' '}
        <button type="button" onClick={() => void run.refetch()}>
          Try again
        </button>
      </p>
    )
  if (!detail) return <p role="status">Loading the run…</p>

  const visuals = replaying ? replay.steps : liveVisuals(detail)
  const hidden = replaying
    ? new Set(detail.stepsList.filter((step) => !replay.steps.has(step.id)).map((s) => s.id))
    : undefined
  const runtimeOfStep = new Map(
    detail.stepsList.map((item) => [
      item.id,
      runtimeLabel(agents.find((agent) => agent.id === item.agentId)?.runtime),
    ]),
  )
  const logEvents = filterLog(replaying ? events.slice(0, count) : events, {
    node: selected,
  }).map((event) => ({
    ...event,
    badge: event.stepId ? (runtimeOfStep.get(event.stepId) ?? null) : null,
  }))
  const step = detail.stepsList.find((item) => item.id === selected)
  const over = isRunOver(detail.status)

  return (
    <div className="orch-live">
      <section className="orch-head" aria-label="Orchestration">
        <div>
          <h3 className="orch-title">{detail.title}</h3>
          <p className="orch-goal">{detail.goal}</p>
          <RunStatus run={detail} />
          <EndSummary
            run={detail}
            steps={detail.steps.succeeded}
            approvals={detail.gates.filter((gate) => gate.decidedAt !== null).length}
          />
        </div>
        <div className="orch-head-actions">
          <RunControls run={detail} actions={actions} />
          <Link to={`/chat/${encodeURIComponent(detail.roomId)}`}>Open the room in Chat</Link>
          {over && events.length > 0 && (
            <button type="button" aria-pressed={replaying} onClick={toggleReplay}>
              {replaying ? 'Back to the final state' : 'Replay this run'}
            </button>
          )}
        </div>
      </section>

      {!replaying && <RunNeeds run={detail} agents={agents} actions={actions} />}

      {replaying && (
        <ReplayBar
          total={events.length}
          count={count}
          playing={playing && count < events.length}
          speed={speed}
          at={events[count - 1]?.at ?? null}
          onCount={setCount}
          onPlaying={setPlaying}
          onSpeed={setSpeed}
        />
      )}
      {replaying && (
        <p className="orch-muted">
          Replay is drawn from the recorded events, not from video. 1× keeps the recorded pace (long
          waits shortened to 3 seconds); 4× and 16× show highlights instead of travelling dots.
        </p>
      )}

      <div className="orch-main">
        <div className="orch-diagram">
          <LiveDiagram
            nodes={graph.nodes}
            edges={graph.edges}
            visuals={visuals}
            lead={replaying ? replay.lead : liveLead(detail)}
            agents={agents}
            selected={selected}
            onSelect={setSelected}
            active={player.active}
            reducedMotion={quiet}
            {...(hidden ? { hidden } : {})}
          />
          <p className="orch-legend orch-muted">
            Dashed outline: queued. Amber with a diamond: needs you. Soft glow in the agent colour:
            running. Tick: succeeded. Cross: failed or blocked. Question mark: not confirmed as
            ended. Dashed line: a replacement.
          </p>
        </div>
        <LiveLog
          events={logEvents}
          node={selected}
          onClearNode={() => setSelected(null)}
          label={replaying ? 'Replay log' : 'Live log'}
        />
      </div>

      {selected && (
        <section className="orch-selected" aria-label="Selected step">
          {selected === LEAD_NODE ? (
            <>
              <h3>Lead</h3>
              <p>
                Lead turn {detail.leadTurnsUsed} of {detail.maxLeadTurns}. The lead decides the
                steps; it can only act through calls that Score checks (see the log).
              </p>
              <PlanList run={detail} />
            </>
          ) : (
            step && <StepCard step={step} run={detail} agents={agents} selected open />
          )}
        </section>
      )}

      <div className="orch-lower">
        <section aria-label="Plan">
          <h3>Plan</h3>
          <PlanList run={detail} />
        </section>
        <section aria-label="Budget and limits">
          <h3>Budget and limits</h3>
          <BudgetBlock run={detail} coding={orchCoding(detail.coding, detail.quotaFloorPercent)} />
        </section>
      </div>
      <FinishBlock run={detail} />
    </div>
  )
}
