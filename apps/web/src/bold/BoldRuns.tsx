import type {
  AgentSummary,
  BudgetView,
  OrchestrationDetail,
  WorkflowRunDetail,
} from '@score/contract'
import { useState, type ReactNode } from 'react'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { useStreamQuery, useStreamQueryRefetch } from '../data/query-client.ts'
import { taskAgentsQuery } from '../data/task-queries.ts'
import { OrchestrationLive } from '../routes/orchestrations/OrchestrationLive.tsx'
import {
  isRunOver,
  leadStepCounts,
  orchCoding,
  statusLabel,
  usd,
  visualLabel,
  type NodeVisual,
} from '../routes/orchestrations/orch-model.ts'
import {
  orchestrationsQuery,
  useRun,
  useRunActions,
} from '../routes/orchestrations/orchestration-queries.ts'
import { AdvisorCard } from '../routes/orchestrations/AdvisorCard.tsx'
import { HelpersCard } from '../routes/orchestrations/HelpersCard.tsx'
import { CheckCard } from '../routes/orchestrations/CheckCard.tsx'
import { AgentChip, RunNeeds } from '../routes/orchestrations/RunDecisions.tsx'
import {
  BudgetBlock,
  EndSummary,
  FinishBlock,
  PlanList,
  RunControls,
  StepCard,
} from '../routes/orchestrations/RunPanel.tsx'
import { StartWorkflowDialog } from '../routes/workflows/StartWorkflowDialog.tsx'
import { WorkflowNeeds } from '../routes/workflows/WorkflowDecisions.tsx'
import { WorkflowNodePanel } from '../routes/workflows/WorkflowNodePanel.tsx'
import { WorkflowRunLive } from '../routes/workflows/WorkflowRunLive.tsx'
import { ownText } from '../routes/workflows/workflow-model.ts'
import {
  useWorkflowRun,
  useWorkflowRunActions,
  workflowRunsQuery,
} from '../routes/workflows/workflow-queries.ts'
import { outcomeLines } from '../routes/workflows/workflow-run-model.ts'
import { Link, useFramed } from '../shell/framed-paths.tsx'
import { agentDisplayName, agentMood } from './bold-agents.ts'
import { boldAgentScreenLink, boldOneToOneLink } from './bold-links.ts'
import {
  filterRuns,
  orchestrationThread,
  runRows,
  workflowThread,
  type RunFilter,
  type RunRow,
  type ThreadStep,
} from './bold-runs-model.ts'
import { ChevronIcon } from './BoldIcons.tsx'
import './bold-runs.css'

const FILTERS: { id: RunFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs', label: 'Needs you' },
  { id: 'running', label: 'Running' },
  { id: 'done', label: 'Done' },
]

const clock = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null

/**
 * The kept classic cards (decisions, graph, log, step details) are drawn with the classic token set; this wrapper
 * gives them that, in the shell's look (never a forced one: a failing theme's contrast fallback keys its colours to the
 * page's look); a decision is marked by the amber outline instead.
 */
function ClassicPaper({
  children,
  tone = 'surface',
}: {
  children: ReactNode
  tone?: 'surface' | 'for-you' | 'plain'
}) {
  const frame = useFramed()
  return (
    <div
      className="bold-run-classic"
      data-tone={tone}
      data-pack="score"
      data-theme={frame?.look ?? 'dark'}
    >
      {children}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------------ the list

function RunsList({ rows, onOpen }: { rows: RunRow[]; onOpen: (briefId: string) => void }) {
  const [filter, setFilter] = useState<RunFilter>('all')
  const shown = filterRuns(rows, filter)
  return (
    <div className="bold-runs-list">
      <div className="bold-runs-filters" role="group" aria-label="Show runs">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={filter === item.id}
            className={`bold-runs-chip${filter === item.id ? ' on' : ''}`}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {rows.length === 0 && (
        <p className="bold-runs-note">
          No runs yet. Start a job from a recipe, or let a lead decide the steps; the run shows up
          here.
        </p>
      )}
      {rows.length > 0 && shown.length === 0 && (
        <p className="bold-runs-note">Nothing matches this filter.</p>
      )}
      <ul className="bold-runs-rows" aria-label="Runs">
        {shown.map((row) => (
          <li key={`${row.kind}:${row.id}`}>
            <button type="button" className="bold-runs-row" onClick={() => onOpen(row.briefId)}>
              <span className="bold-runs-row-main">
                <b>{row.title}</b>
                <span className="bold-runs-row-sub">
                  {row.source ? `${row.source} · ` : 'Lead decides · '}
                  {row.statusText} · {row.progress}
                </span>
              </span>
              {row.needs > 0 && (
                <span className="bold-run-wait" data-protected="inline">
                  Needs you ({row.needs})
                </span>
              )}
              <ChevronIcon />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ------------------------------------------------------------------------------------------------------ the thread

function StepMark({ visual, n }: { visual: NodeVisual; n: number }) {
  const mark =
    visual === 'succeeded'
      ? '✓'
      : visual === 'failed' || visual === 'rejected' || visual === 'blocked'
        ? '✕'
        : visual === 'gate'
          ? '◆'
          : visual === 'unknown' || visual === 'abandoned'
            ? '?'
            : String(n)
  return (
    <span className={`bold-run-num bold-run-num--${visual}`} aria-hidden="true">
      {mark}
    </span>
  )
}

function Reply({ text }: { text: string }) {
  const long = text.length > 420
  return (
    <div className="bold-run-reply">
      {long ? (
        <>
          <p>{text.slice(0, 420)}…</p>
          <details>
            <summary>Show the whole reply</summary>
            <pre>{text}</pre>
          </details>
        </>
      ) : (
        <p>{text}</p>
      )}
    </div>
  )
}

function Thread({
  steps,
  agents,
  over,
  details,
}: {
  steps: ThreadStep[]
  agents: AgentSummary[]
  over: boolean
  details: (step: ThreadStep) => ReactNode
}) {
  return (
    <ol className="bold-run-thread" aria-label="Steps">
      {steps.map((step) => {
        const agent = step.agentId ? agents.find((item) => item.id === step.agentId) : undefined
        const failed = ['failed', 'blocked', 'rejected'].includes(step.visual)
        const detail = details(step)
        return (
          <li
            key={step.id}
            className="bold-run-step"
            data-visual={step.visual}
            data-future={
              !over && ['waiting', 'queued', 'ready', 'not_started'].includes(step.visual)
                ? 'true'
                : undefined
            }
          >
            <div className="bold-run-rail">
              <StepMark visual={step.visual} n={step.n} />
            </div>
            <div className="bold-run-body">
              <div className="bold-run-who">
                {step.agentId && (
                  <>
                    {agent ? (
                      <AgentGlyph agent={agent} size="xs" bare decorative mood={agentMood(agent)} />
                    ) : null}
                    <b>{agent ? agentDisplayName(agent) : step.agentId}</b>
                  </>
                )}
                {!step.agentId && <b>{step.kind === 'gate' ? 'Gate' : 'Step'}</b>}
                <span className="bold-run-title">{step.title}</span>
                <span className={`bold-run-state bold-run-state--${step.visual}`}>
                  {visualLabel[step.visual]}
                </span>
                {step.tries && <span className="bold-run-tries">{step.tries}</span>}
                {step.waitsOnYou && (
                  <span className="bold-run-wait" data-protected="inline">
                    Waits for you
                  </span>
                )}
              </div>
              {step.note && <p className="bold-run-note">{step.note}</p>}
              {step.reply && <Reply text={step.reply} />}
              {step.agentId && (
                <div className="bold-run-links">
                  <Link to={boldAgentScreenLink(step.agentId)}>Its screen</Link>
                  {failed && (
                    <Link to={boldOneToOneLink(step.agentId)}>
                      Take it aside with {agent ? agentDisplayName(agent) : step.agentId}
                    </Link>
                  )}
                </div>
              )}
              {detail && (
                <details className="bold-run-more">
                  <summary>Details of this step</summary>
                  <ClassicPaper>{detail}</ClassicPaper>
                </details>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

// ------------------------------------------------------------------------------------------------------- the run

type Tab = 'steps' | 'graph' | 'log'
const TABS: { id: Tab; label: string }[] = [
  { id: 'steps', label: 'Steps' },
  { id: 'graph', label: 'Graph' },
  { id: 'log', label: 'Log' },
]

function SpendTile({ budget }: { budget: BudgetView }) {
  const used = budget.settledUsd + budget.provisionalUsd
  const limit = budget.limitUsd
  const settledPct = limit && limit > 0 ? Math.min(100, (budget.settledUsd / limit) * 100) : 0
  const provisionalPct =
    limit && limit > 0 ? Math.min(100 - settledPct, (budget.provisionalUsd / limit) * 100) : 0
  return (
    <div className="bold-run-tile" aria-label="Spend">
      <span className="bold-run-tile-head">
        <span>Spend</span>
        <b>{limit === null ? usd(used) : `${usd(used)} of ${usd(limit)}`}</b>
      </span>
      {limit !== null && (
        <span className="bold-run-meter" aria-hidden="true">
          <span style={{ width: `${settledPct}%` }} />
          <span className="is-provisional" style={{ width: `${provisionalPct}%` }} />
        </span>
      )}
      <span className="bold-run-tile-sub">
        {usd(budget.settledUsd)} settled · {usd(budget.provisionalUsd)} not settled yet
        {budget.unknownSpend ? ' · some spend is unknown' : ''}
      </span>
    </div>
  )
}

function Tile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bold-run-tile" aria-label={label}>
      <span className="bold-run-tile-head">
        <span>{label}</span>
      </span>
      {children}
    </div>
  )
}

interface RunFrameProps {
  title: string
  subtitle: string
  statusText: string
  over: boolean
  roomId: string
  tiles: ReactNode
  steps: ThreadStep[]
  agents: AgentSummary[]
  needs: ReactNode
  controls: ReactNode
  summary: ReactNode
  details: (step: ThreadStep) => ReactNode
  graph: (pane: 'graph' | 'log') => ReactNode
  budget: ReactNode
  /** Extra buttons next to the controls (Run again…). */
  extra?: ReactNode
  outcome?: string[]
  /** The lead's goal (orchestration). */
  goal?: string
  /** Shown before the thread, after the decisions (workflow agents that changed). */
  warnings?: ReactNode
  onBack: () => void
}

function RunFrame(props: RunFrameProps) {
  const [tab, setTab] = useState<Tab>('steps')
  return (
    <div className="bold-run">
      <div className="bold-run-bar">
        <button type="button" className="btn sm" onClick={props.onBack}>
          All runs
        </button>
        <div role="tablist" aria-label="How to see the run" className="bold-run-tabs">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`bold-run-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls="bold-run-panel"
              className={tab === item.id ? 'on' : undefined}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="bold-run-actions">
          {props.extra}
          <ClassicPaper tone="plain">{props.controls}</ClassicPaper>
        </span>
      </div>
      <div className="bold-run-head">
        <h2>{props.title}</h2>
        <p className="bold-run-sub">
          <span className="bold-run-status">{props.statusText}</span>
          {props.subtitle ? ` · ${props.subtitle}` : ''}
        </p>
        {props.goal && <p className="bold-run-goal">{props.goal}</p>}
        {props.outcome && props.outcome.length > 0 && (
          <p className="bold-run-sub">
            {props.outcome.map((line, index) => (
              <span key={index}>
                {index > 0 ? ' · ' : ''}
                <span>{line}</span>
              </span>
            ))}
          </p>
        )}
      </div>
      <div className="bold-run-tiles">{props.tiles}</div>
      {props.needs}
      {props.warnings}
      <div
        id="bold-run-panel"
        role="tabpanel"
        aria-labelledby={`bold-run-tab-${tab}`}
        className="bold-run-panel"
      >
        {tab === 'steps' && (
          <>
            <Thread
              steps={props.steps}
              agents={props.agents}
              over={props.over}
              details={props.details}
            />
            <ClassicPaper>
              {props.summary}
              <details className="bold-run-budget">
                <summary>Budget and limits in full</summary>
                {props.budget}
              </details>
            </ClassicPaper>
          </>
        )}
        {tab !== 'steps' && <ClassicPaper>{props.graph(tab)}</ClassicPaper>}
      </div>
      <p className="bold-run-foot">
        <Link to={`/chat/${encodeURIComponent(props.roomId)}`}>Open the room</Link>
      </p>
    </div>
  )
}

function OrchestrationRun({
  detail,
  agents,
  onBack,
}: {
  detail: OrchestrationDetail
  agents: AgentSummary[]
  onBack: () => void
}) {
  const actions = useRunActions(detail.id)
  const over = isRunOver(detail.status)
  const coding = orchCoding(detail.coding, detail.quotaFloorPercent)
  return (
    <RunFrame
      title={detail.title}
      subtitle={`Lead decides · started ${clock(detail.createdAt) ?? ''}`}
      statusText={statusLabel[detail.status]}
      goal={detail.goal}
      over={over}
      roomId={detail.roomId}
      agents={agents}
      steps={orchestrationThread(detail)}
      tiles={
        <>
          <SpendTile budget={detail.budget} />
          <Tile label="Limits">
            <span className="bold-run-tile-line">
              {detail.deadlineAt ? `Deadline ${clock(detail.deadlineAt)}` : 'No deadline'}
            </span>
            <span className="bold-run-tile-sub">
              Steps {detail.steps.total} of {detail.maxSteps} · lead turns {detail.leadTurnsUsed} of{' '}
              {detail.maxLeadTurns}
              {coding ? ` · coding steps up to ${coding.codingSteps}` : ''}
            </span>
          </Tile>
          <Tile label="Team on this run">
            <span className="bold-run-tile-line">
              {detail.allowedAgents.length} {detail.allowedAgents.length === 1 ? 'agent' : 'agents'}{' '}
              allowed
            </span>
            <span className="bold-run-tile-sub">
              {detail.gatePolicy === 'every-step'
                ? 'Asks you before every step'
                : detail.gatePolicy === 'lead-asks'
                  ? 'The lead asks you at gates'
                  : 'No approvals needed'}
            </span>
          </Tile>
        </>
      }
      needs={
        // Always mounted: a decided card leaves a chip behind for a moment, which the list itself draws.
        <ClassicPaper tone="for-you">
          <RunNeeds run={detail} agents={agents} actions={actions} />
        </ClassicPaper>
      }
      controls={<RunControls run={detail} actions={actions} />}
      summary={
        <>
          <section aria-label="Plan">
            <h3>Plan</h3>
            <PlanList run={detail} />
          </section>
          <EndSummary
            run={detail}
            steps={leadStepCounts(detail.stepsList).succeeded}
            approvals={detail.gates.filter((gate) => gate.decidedAt !== null).length}
          />
          <AdvisorCard run={detail} agents={agents} />
          <HelpersCard run={detail} agents={agents} />
          <CheckCard run={detail} actions={actions} />
          <FinishBlock run={detail} />
        </>
      }
      details={(step) => {
        const item = detail.stepsList.find((entry) => entry.id === step.id)
        return item ? <StepCard step={item} run={detail} agents={agents} selected open /> : null
      }}
      graph={(pane) => <OrchestrationLive orchestrationId={detail.id} pane={pane} />}
      budget={<BudgetBlock run={detail} coding={coding} />}
      onBack={onBack}
    />
  )
}

function WorkflowRun({
  detail,
  agents,
  onBack,
  onOpen,
}: {
  detail: WorkflowRunDetail
  agents: AgentSummary[]
  onBack: () => void
  onOpen: (briefId: string) => void
}) {
  const actions = useWorkflowRunActions(detail.id)
  const [again, setAgain] = useState(false)
  const over = isRunOver(detail.status)
  const { graph, note } = outcomeLines(detail)
  const changedAgents = detail.agentMap.filter((entry) => entry.status !== 'current')
  return (
    <>
      <RunFrame
        title={detail.title}
        subtitle={`${detail.workflowName} · version ${detail.version} · started ${clock(detail.createdAt) ?? ''}${detail.rerunOf ? ' · a re-run' : ''}`}
        statusText={statusTextOf(detail)}
        over={over}
        roomId={detail.roomId}
        agents={agents}
        steps={workflowThread(detail)}
        outcome={[graph, note, detail.endReason].filter((line): line is string => Boolean(line))}
        tiles={
          <>
            <SpendTile budget={detail.budget} />
            <Tile label="Limits">
              <span className="bold-run-tile-line">
                {detail.deadlineAt ? `Deadline ${clock(detail.deadlineAt)}` : 'No deadline'}
              </span>
              <span className="bold-run-tile-sub">
                {detail.nodes.succeeded} of {detail.nodes.total} steps done
                {detail.nodes.skipped > 0 ? `, ${detail.nodes.skipped} skipped` : ''} ·{' '}
                {detail.gatePolicy === 'every-step'
                  ? 'asks before every agent step'
                  : 'asks only at gates'}
                {detail.coding
                  ? ` · coding steps ${detail.coding.used} of ${detail.coding.codingSteps}`
                  : ''}
              </span>
            </Tile>
            <Tile label="Inputs">
              {detail.definition.inputs.length === 0 ? (
                <span className="bold-run-tile-sub">None</span>
              ) : (
                <span className="bold-run-chips">
                  {detail.definition.inputs.map((input) => (
                    <code key={input.name}>
                      {input.label} = {ownText(detail.inputs, input.name)}
                    </code>
                  ))}
                </span>
              )}
            </Tile>
          </>
        }
        needs={
          <ClassicPaper tone="for-you">
            <WorkflowNeeds run={detail} agents={agents} actions={actions} />
          </ClassicPaper>
        }
        controls={<RunControls run={detail} actions={actions} />}
        warnings={changedAgents.length > 0 ? <AgentWarnings entries={changedAgents} /> : null}
        extra={
          over && (
            <>
              {changedAgents.length > 0 && (
                <span className="bold-run-wait" data-protected="inline">
                  {changedAgents.length} {changedAgents.length === 1 ? 'agent' : 'agents'} changed
                </span>
              )}
              <button type="button" className="btn sm" onClick={() => setAgain(true)}>
                Run again…
              </button>
            </>
          )
        }
        summary={
          <>
            <EndSummary
              run={detail}
              steps={detail.nodes.succeeded}
              approvals={
                [...detail.nodeGates, ...detail.assignmentGates].filter(
                  (gate) => gate.decidedAt !== null,
                ).length
              }
            />
            <section aria-label="This run">
              <h3>This run</h3>
              <dl className="orch-facts">
                <dt>Workflow</dt>
                <dd>
                  <Link to={`/workflows/${encodeURIComponent(detail.workflowId)}`}>
                    {detail.workflowName}
                  </Link>
                  , version {detail.version}
                </dd>
                <dt>Agents</dt>
                <dd>
                  <ul className="wf-agents">
                    {detail.agentMap.map((entry) => (
                      <li key={entry.agentId}>
                        <AgentChip agentId={entry.agentId} agents={agents} />{' '}
                        <span className="orch-muted">version {entry.incarnation}</span>{' '}
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
          </>
        }
        details={(step) =>
          step.kind === 'lead' ? null : (
            <WorkflowNodePanel run={detail} nodeId={step.id} agents={agents} />
          )
        }
        graph={(pane) => <WorkflowRunLive runId={detail.id} onStarted={() => {}} pane={pane} />}
        budget={
          <>
            <BudgetBlock run={detail} coding={detail.coding} />
            <p className="orch-muted">{detail.spend.note}</p>
          </>
        }
        onBack={onBack}
      />
      {again && (
        <ClassicPaper tone="plain">
          <StartWorkflowDialog
            workflowId={detail.workflowId}
            version={detail.version}
            initialInputs={detail.inputs}
            rerunOf={detail.id}
            agents={agents}
            close={() => setAgain(false)}
            created={(created) => {
              setAgain(false)
              onOpen(created.briefId)
            }}
          />
        </ClassicPaper>
      )}
    </>
  )
}

/** An agent the run was started with that has since been replaced or removed: said before the results. */
function AgentWarnings({ entries }: { entries: WorkflowRunDetail['agentMap'] }) {
  return (
    <ul className="bold-run-warnings" aria-label="Agents that changed" data-protected="block">
      {entries.map((entry) => (
        <li key={entry.agentId}>
          <b>{entry.agentId}</b>{' '}
          {entry.status === 'changed'
            ? `was replaced since this run started (it runs with ${entry.incarnation}).`
            : `was removed since this run started (it ran as ${entry.incarnation}).`}
        </li>
      ))}
    </ul>
  )
}

function statusTextOf(detail: WorkflowRunDetail): string {
  return detail.status === 'paused' && detail.pauseReason
    ? `Paused: ${detail.pauseReason.replaceAll('_', ' ')}`
    : statusLabel[detail.status]
}

function LoadError({ what, retry }: { what: string; retry: () => void }) {
  return (
    <p className="bold-runs-note" role="alert">
      Couldn’t load {what}.{' '}
      <button type="button" className="bold-runs-link" onClick={retry}>
        Try again
      </button>
    </p>
  )
}

function OrchestrationRunLoader({
  id,
  agents,
  onBack,
}: {
  id: string
  agents: AgentSummary[]
  onBack: () => void
}) {
  const run = useRun(id)
  const detail = run.data?.snapshot.orchestration
  if (run.isError && !detail) return <LoadError what="this run" retry={() => void run.refetch()} />
  if (!detail)
    return (
      <p className="bold-runs-note" role="status">
        Loading the run…
      </p>
    )
  return <OrchestrationRun detail={detail} agents={agents} onBack={onBack} />
}

function WorkflowRunLoader({
  id,
  agents,
  onBack,
  onOpen,
}: {
  id: string
  agents: AgentSummary[]
  onBack: () => void
  onOpen: (briefId: string) => void
}) {
  const run = useWorkflowRun(id)
  const detail = run.data?.snapshot.run
  if (run.isError && !detail) return <LoadError what="this run" retry={() => void run.refetch()} />
  if (!detail)
    return (
      <p className="bold-runs-note" role="status">
        Loading the run…
      </p>
    )
  return <WorkflowRun detail={detail} agents={agents} onBack={onBack} onOpen={onOpen} />
}

/**
 * The Runs side panel (decision 131): every run in one list, and a run opened from its brief id as a thread of steps.
 * `briefId` is the address (`?run=`), so links from jobs, search and notifications land on the same run.
 */
export function BoldRuns({
  briefId,
  onOpen,
  onBack,
}: {
  briefId: string | null
  onOpen: (briefId: string) => void
  onBack: () => void
}) {
  const orchestrations = useStreamQuery(orchestrationsQuery)
  const workflows = useStreamQuery(workflowRunsQuery)
  const agents = useStreamQuery(taskAgentsQuery).data ?? []
  const refetchOrchestrations = useStreamQueryRefetch(orchestrationsQuery)
  const refetchWorkflows = useStreamQueryRefetch(workflowRunsQuery)
  const orchestration = briefId
    ? orchestrations.data?.find((run) => run.briefId === briefId)
    : undefined
  const workflow = briefId ? workflows.data?.find((run) => run.briefId === briefId) : undefined
  const pending = orchestrations.status === 'pending' || workflows.status === 'pending'
  const failed = orchestrations.status === 'error' && workflows.status === 'error'
  const retry = () => {
    void refetchOrchestrations()
    void refetchWorkflows()
  }

  let body: ReactNode
  if (briefId && (workflow || orchestration)) {
    body = workflow ? (
      <WorkflowRunLoader
        key={workflow.id}
        id={workflow.id}
        agents={agents}
        onBack={onBack}
        onOpen={onOpen}
      />
    ) : (
      <OrchestrationRunLoader
        key={orchestration!.id}
        id={orchestration!.id}
        agents={agents}
        onBack={onBack}
      />
    )
  } else if (failed) {
    body = <LoadError what={briefId ? 'this run' : 'the runs'} retry={retry} />
  } else if (pending) {
    body = (
      <p className="bold-runs-note" role="status">
        {briefId ? 'Loading the run…' : 'Loading the runs…'}
      </p>
    )
  } else if (briefId) {
    body = (
      <div className="bold-runs-note" role="alert">
        <p>That run isn’t available.</p>
        <button type="button" className="btn sm" onClick={onBack}>
          All runs
        </button>
      </div>
    )
  } else {
    body = (
      <RunsList rows={runRows(orchestrations.data ?? [], workflows.data ?? [])} onOpen={onOpen} />
    )
  }
  return (
    <div className="sidebody bold-runs" aria-label="Runs">
      {body}
    </div>
  )
}
