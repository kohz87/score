import type { OrchEvent, OrchestrationDetail } from '@score/contract'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useStreamQuery } from '../../data/query-client.ts'
import { taskAgentsQuery } from '../tasks/task-queries.ts'
import { LiveDiagram, useEffectPlayer, usePrefersReducedMotion } from './LiveDiagram.tsx'
import { LiveLog } from './LiveLog.tsx'
import {
  buildGraph,
  eventEffect,
  filterLog,
  freshEvents,
  isRunOver,
  LEAD_NODE,
  replayAt,
  replayDelayMs,
  stepVisual,
  type NodeVisual,
} from './orch-model.ts'
import { useRun, useRunActions } from './orchestration-queries.ts'
import {
  BudgetBlock,
  FinishBlock,
  PlanList,
  RunControls,
  RunStatus,
  StepCard,
} from './RunPanel.tsx'
import { RunNeeds } from './RunDecisions.tsx'
import './orchestrations.css'

const SPEEDS = [1, 4, 16] as const
type Speed = (typeof SPEEDS)[number]

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

function ReplayBar({
  total,
  count,
  playing,
  speed,
  at,
  onCount,
  onPlaying,
  onSpeed,
}: {
  total: number
  count: number
  playing: boolean
  speed: Speed
  at: string | null
  onCount: (n: number) => void
  onPlaying: (playing: boolean) => void
  onSpeed: (speed: Speed) => void
}) {
  return (
    <div className="orch-replay" role="group" aria-label="Replay">
      <button
        type="button"
        onClick={() => onCount(Math.max(0, count - 1))}
        disabled={count <= 0}
        aria-label="Step back"
      >
        ◀︎
      </button>
      <button
        type="button"
        className="orch-primary"
        onClick={() => {
          if (count >= total) {
            onCount(0)
            onPlaying(true)
          } else onPlaying(!playing)
        }}
      >
        {playing ? 'Pause' : count >= total ? 'Replay again' : 'Play'}
      </button>
      <button
        type="button"
        onClick={() => onCount(Math.min(total, count + 1))}
        disabled={count >= total}
        aria-label="Step forward"
      >
        ▶︎
      </button>
      <input
        type="range"
        min={0}
        max={total}
        value={count}
        aria-label="Replay position"
        aria-valuetext={`Event ${count} of ${total}${at ? `, ${new Date(at).toLocaleTimeString()}` : ''}`}
        onChange={(event) => {
          onPlaying(false)
          onCount(Number(event.target.value))
        }}
      />
      <span className="orch-muted" aria-live="off">
        {count} / {total}
      </span>
      <span role="radiogroup" aria-label="Replay speed" className="orch-speeds">
        {SPEEDS.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={speed === value}
            className={speed === value ? 'orch-on' : undefined}
            onClick={() => onSpeed(value)}
          >
            {value}×
          </button>
        ))}
      </span>
    </div>
  )
}

/** The run as a live diagram with a log beside it; a finished run can be replayed from its event history. */
export function OrchestrationLive({ orchestrationId }: { orchestrationId: string }) {
  const run = useRun(orchestrationId)
  const agents = useStreamQuery(taskAgentsQuery).data ?? []
  const actions = useRunActions(orchestrationId)
  const reducedMotion = usePrefersReducedMotion()
  const [mode, setMode] = useState<'live' | 'replay'>('live')
  const [selected, setSelected] = useState<string | null>(null)
  const [count, setCount] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<Speed>(1)
  const detail = run.data?.snapshot.orchestration
  const events: OrchEvent[] = useMemo(() => run.data?.events ?? [], [run.data])
  const quiet = reducedMotion || (mode === 'replay' && speed > 1)
  const player = useEffectPlayer(quiet)

  // Live: dots and highlights play back events that arrive after the page loaded. What was already there is not
  // replayed (that is what Replay is for), and nothing is shown that no event caused.
  const seen = useRef<{ id: string; ids: Set<string> } | null>(null)
  useEffect(() => {
    if (!run.data) return
    if (!seen.current || seen.current.id !== orchestrationId) {
      seen.current = { id: orchestrationId, ids: new Set(events.map((event) => event.id)) }
      return
    }
    const fresh = freshEvents(seen.current.ids, events)
    for (const event of fresh) seen.current.ids.add(event.id)
    if (mode !== 'live' || fresh.length === 0) return
    const known = new Set(run.data.snapshot.orchestration.stepsList.map((step) => step.id))
    player.enqueue(fresh.flatMap((event) => eventEffect(event, known) ?? []))
  }, [run.data, events, orchestrationId, mode, player])

  // Replay: advance one event after the recorded gap (kept readable), scaled by the speed.
  const { enqueue } = player
  useEffect(() => {
    if (mode !== 'replay' || !playing || count >= events.length) return
    const wait = count === 0 ? Math.round(300 / speed) : replayDelayMs(events, count - 1, speed)
    const timer = setTimeout(() => {
      const event = events[count]
      const effect =
        event && detail
          ? eventEffect(event, new Set(detail.stepsList.map((step) => step.id)))
          : null
      if (effect) enqueue([effect])
      setCount(count + 1)
    }, wait)
    return () => clearTimeout(timer)
  }, [mode, playing, count, speed, events, detail, enqueue])

  const replay = useMemo(() => replayAt(events, count), [events, count])
  const graph = useMemo(() => (detail ? buildGraph(detail) : { nodes: [], edges: [] }), [detail])
  if (run.isError)
    return (
      <p role="alert" className="orch-error">
        This run could not load.{' '}
        <button type="button" onClick={() => void run.refetch()}>
          Try again
        </button>
      </p>
    )
  if (!detail) return <p role="status">Loading the run…</p>

  const replaying = mode === 'replay'
  const visuals = replaying ? replay.steps : liveVisuals(detail)
  const hidden = replaying
    ? new Set(detail.stepsList.filter((step) => !replay.steps.has(step.id)).map((s) => s.id))
    : undefined
  const logEvents = filterLog(replaying ? events.slice(0, count) : events, { node: selected })
  const step = detail.stepsList.find((item) => item.id === selected)
  const over = isRunOver(detail.status)

  return (
    <div className="orch-live">
      <section className="orch-head" aria-label="Orchestration">
        <div>
          <h3 className="orch-title">{detail.title}</h3>
          <p className="orch-goal">{detail.goal}</p>
          <RunStatus run={detail} />
        </div>
        <div className="orch-head-actions">
          <RunControls run={detail} actions={actions} />
          <Link to={`/chat/${encodeURIComponent(detail.roomId)}`}>Open the room in Chat</Link>
          {over && events.length > 0 && (
            <button
              type="button"
              aria-pressed={replaying}
              onClick={() => {
                player.reset()
                setPlaying(false)
                setCount(replaying ? 0 : 0)
                setMode(replaying ? 'live' : 'replay')
              }}
            >
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
          onCount={(n) => {
            player.reset()
            setCount(n)
          }}
          onPlaying={setPlaying}
          onSpeed={setSpeed}
        />
      )}
      {replaying && (
        <p className="orch-muted">
          Replay is drawn from the recorded events, not from video. 1× keeps the recorded pace (long
          waits shortened to 3 s); 4× and 16× show highlights instead of travelling dots.
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
            Dashed outline: queued. Diamond: needs you. Dot: running. Check: succeeded. Cross:
            failed or blocked. Question mark: not confirmed ended. Dashed line: a replacement.
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
        <section className="orch-selected" aria-label="Selected node">
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
          <BudgetBlock run={detail} />
        </section>
      </div>
      <FinishBlock run={detail} />
    </div>
  )
}
