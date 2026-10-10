import type { WorkflowEvent } from '@score/contract'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useStreamQuery } from '../../data/query-client.ts'
import { LiveDiagram } from '../orchestrations/LiveDiagram.tsx'
import { LiveLog } from '../orchestrations/LiveLog.tsx'
import { isRunOver, replayDelayMs, statusLabel } from '../orchestrations/orch-model.ts'
import { ReplayBar } from '../orchestrations/ReplayBar.tsx'
import { BudgetBlock, RunControls } from '../orchestrations/RunPanel.tsx'
import { useRunPlayback } from '../orchestrations/use-run-playback.ts'
import { AgentChip } from '../orchestrations/RunDecisions.tsx'
import { taskAgentsQuery } from '../tasks/task-queries.ts'
import { StartWorkflowDialog } from './StartWorkflowDialog.tsx'
import { WorkflowNeeds } from './WorkflowDecisions.tsx'
import { WorkflowNodePanel } from './WorkflowNodePanel.tsx'
import { useWorkflowRun, useWorkflowRunActions } from './workflow-queries.ts'
import {
  buildWorkflowGraph,
  captionsOf,
  describeWorkflowEvents,
  edgeIndex,
  edgeStatesOf,
  filterWorkflowLog,
  liveWorkflowVisuals,
  outcomeLines,
  workflowEventEffect,
  workflowReplayAt,
} from './workflow-run-model.ts'
import '../orchestrations/orchestrations.css'
import './workflows.css'

/**
 * A workflow run: the definition's graph with the run's live state, the log beside it and, once it is over, a replay of
 * the recorded events. Built from the same parts as an orchestration's page.
 */
export function WorkflowRunLive({
  runId,
  onStarted,
}: {
  runId: string
  /** The brief of a run started from here (Run again), to open its page. */
  onStarted: (run: { id: string; briefId: string }) => void
}) {
  const run = useWorkflowRun(runId)
  const agents = useStreamQuery(taskAgentsQuery).data ?? []
  const actions = useWorkflowRunActions(runId)
  const [selected, setSelected] = useState<string | null>(null)
  const [again, setAgain] = useState(false)
  const detail = run.data?.snapshot.run
  const events: WorkflowEvent[] = useMemo(() => run.data?.events ?? [], [run.data])

  const edges = useMemo(() => (detail ? edgeIndex(detail.definition) : new Map()), [detail])
  const tokenKinds = useMemo(
    () => new Map((detail?.tokens ?? []).map((token) => [token.edgeId, token.kind] as const)),
    [detail],
  )
  const nodeIds = useMemo(() => detail?.definition.nodes.map((node) => node.id) ?? [], [detail])
  const nodeSet = useMemo(() => new Set(nodeIds), [nodeIds])
  const playback = useRunPlayback({
    id: runId,
    loaded: run.data !== undefined,
    events,
    effectOf: (event) => workflowEventEffect(event, edges, tokenKinds, nodeSet),
    delayMs: replayDelayMs,
  })
  const { replaying, count, playing, speed, quiet, player } = playback

  const replay = useMemo(
    () => workflowReplayAt(events, count, nodeIds, tokenKinds),
    [events, count, nodeIds, tokenKinds],
  )
  const graph = useMemo(
    () => (detail ? buildWorkflowGraph(detail.definition, captionsOf(detail)) : null),
    [detail],
  )
  const replayGraph = useMemo(
    () => (detail ? buildWorkflowGraph(detail.definition) : null),
    [detail],
  )

  if (run.isError)
    return (
      <p role="alert" className="orch-error">
        This run could not load.{' '}
        <button type="button" onClick={() => void run.refetch()}>
          Try again
        </button>
      </p>
    )
  if (!detail || !graph || !replayGraph) return <p role="status">Loading the run…</p>

  const visuals = replaying ? replay.nodes : liveWorkflowVisuals(detail)
  const edgeStates = replaying ? replay.edges : edgeStatesOf(detail.tokens)
  const agentName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id
  const logEvents = describeWorkflowEvents(
    filterWorkflowLog(replaying ? events.slice(0, count) : events, selected),
    detail,
    agentName,
  )
  const over = isRunOver(detail.status)
  const { graph: graphLine, note } = outcomeLines(detail)
  const selectedLabel = detail.definition.nodes.find((node) => node.id === selected)?.label

  return (
    <div className="orch-live wf-run">
      <section className="orch-head" aria-label="Workflow run">
        <div>
          <h3 className="orch-title">{detail.title}</h3>
          <p className="orch-muted">
            Workflow{' '}
            <Link to={`/now/flow/workflows/${encodeURIComponent(detail.workflowId)}`}>
              {detail.workflowName}
            </Link>
            , version {detail.version}.{' '}
            {detail.gatePolicy === 'every-step'
              ? 'Asks you before every agent step and at gates.'
              : 'Asks you only at gates.'}
            {detail.rerunOf ? ' A re-run of an earlier run.' : ''}
          </p>
          <div className="orch-status">
            <span className={`orch-badge orch-badge--${detail.status}`}>
              {statusLabel[detail.status]}
            </span>
            {graphLine && (
              <span className={`orch-badge wf-graph-badge wf-graph-badge--${detail.graphOutcome}`}>
                {graphLine}
              </span>
            )}
            {detail.status === 'paused' && detail.pauseReason && (
              <span>Paused: {detail.pauseReason.replaceAll('_', ' ')}</span>
            )}
            <span className="orch-muted">
              {detail.nodes.succeeded} of {detail.nodes.total} nodes done
              {detail.nodes.skipped > 0 ? `, ${detail.nodes.skipped} skipped` : ''}
            </span>
          </div>
          {note && <p className="wf-outcome-note">{note}</p>}
          {detail.endReason && <p className="orch-muted">{detail.endReason}</p>}
        </div>
        <div className="orch-head-actions">
          <RunControls run={detail} actions={actions} />
          <Link to={`/chat/${encodeURIComponent(detail.roomId)}`}>Open the room in Chat</Link>
          {over && events.length > 0 && (
            <button type="button" aria-pressed={replaying} onClick={playback.toggleReplay}>
              {replaying ? 'Back to the final state' : 'Replay this run'}
            </button>
          )}
          {over && (
            <button type="button" className="orch-primary" onClick={() => setAgain(true)}>
              Run again…
            </button>
          )}
        </div>
      </section>

      {!replaying && <WorkflowNeeds run={detail} agents={agents} actions={actions} />}

      {replaying && (
        <ReplayBar
          total={events.length}
          count={count}
          playing={playing && count < events.length}
          speed={speed}
          at={events[count - 1]?.at ?? null}
          onCount={playback.setCount}
          onPlaying={playback.setPlaying}
          onSpeed={playback.setSpeed}
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
            nodes={replaying ? replayGraph.nodes : graph.nodes}
            edges={graph.edges}
            visuals={visuals}
            lead="idle"
            agents={agents}
            selected={selected}
            onSelect={setSelected}
            active={player.active}
            reducedMotion={quiet}
            edgeStates={edgeStates}
            noun="Step"
            ariaLabel="Diagram of the workflow run. The log next to it says the same in words."
            columnGap={84}
          />
          <p className="orch-legend orch-muted">
            Diamond: a gate that waits for you. Hexagon: a branch. Solid line: a path taken. Dotted,
            faded: a path that was passed over. Dashed coral: a failure or rejection route. Dashed
            outline: not reached yet.
          </p>
        </div>
        <LiveLog
          events={logEvents}
          node={selected === null ? null : (selectedLabel ?? selected)}
          onClearNode={() => setSelected(null)}
          label={replaying ? 'Replay log' : 'Live log'}
        />
      </div>

      {selected && <WorkflowNodePanel run={detail} nodeId={selected} agents={agents} />}

      <div className="orch-lower">
        <section aria-label="This run">
          <h3>This run</h3>
          <dl className="orch-facts">
            <dt>Inputs</dt>
            <dd>
              {Object.keys(detail.inputs).length === 0 ? (
                'None'
              ) : (
                <ul className="wf-inputs">
                  {detail.definition.inputs.map((input) => (
                    <li key={input.name}>
                      <strong>{input.label}:</strong>{' '}
                      <span className="wf-input-value">{detail.inputs[input.name] ?? ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
            <dt>Agents</dt>
            <dd>
              <ul className="wf-agents">
                {detail.agentMap.map((entry) => (
                  <li key={entry.agentId}>
                    <AgentChip agentId={entry.agentId} agents={agents} />{' '}
                    <span
                      className="wf-incarnation"
                      role="img"
                      tabIndex={0}
                      title={`The exact agent this run uses (${entry.incarnation})`}
                      aria-label={`Incarnation ${entry.incarnation}`}
                    >
                      ⓘ
                    </span>{' '}
                    {entry.status !== 'current' && (
                      <strong className="orch-error">
                        {entry.status === 'changed' ? 'replaced since' : 'removed'}
                      </strong>
                    )}
                  </li>
                ))}
              </ul>
            </dd>
          </dl>
        </section>
        <section aria-label="Budget and limits">
          <h3>Budget and limits</h3>
          <BudgetBlock run={detail} />
          <p className="orch-muted">{detail.spend.note}</p>
        </section>
      </div>

      {again && (
        <StartWorkflowDialog
          workflowId={detail.workflowId}
          version={detail.version}
          initialInputs={detail.inputs}
          rerunOf={detail.id}
          agents={agents}
          close={() => setAgain(false)}
          created={(created) => {
            setAgain(false)
            onStarted(created)
          }}
        />
      )}
    </div>
  )
}
