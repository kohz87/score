import type { AgentSummary, OrchEvent, OrchestrationDetail } from '@score/contract'
import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { PHONE_QUERY, useMediaQuery } from '../../data/use-media.ts'
import { usePrefersReducedMotion } from '../../motion/motion.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { taskAgentsQuery } from '../../data/task-queries.ts'
import { useRun, useRunActions } from '../../routes/orchestrations/orchestration-queries.ts'
import {
  canStopStep,
  quietMinutes,
  StepStopButton,
  StuckStepCard,
  useNow,
  type StopStepAction,
} from '../../routes/orchestrations/StepStop.tsx'
import { visualLabel } from '../../routes/orchestrations/orch-model.ts'
import { useFramed } from '../../shell/framed-paths.tsx'
import {
  buildJobMap,
  formatTokens,
  LAYER_LABEL,
  logFor,
  type LayerId,
  type JobMapModel,
  type WorkerNode,
} from './job-map-model.ts'
import './jobmap.css'

// 3.15 (decision 151): the job's main view is a layered graph, rebuilt from docs/design/jobmap/graph-desktop.html and
// graph-phone.html with the bold tokens. Each layer is one node that summarises itself; layers a job doesn't use are not
// drawn. The session log under it doubles as the text alternative of the graph.

const clockOf = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** The quiet part of a line between two nodes; dots run along it only while work flows into the layer below. */
/** Step chips shown on one worker node before the rest are counted. */
const CHIP_LIMIT = 12

interface AdvisorLink {
  agentId: string
  d: string
  running: boolean
  label: string
  question: string | null
  labelX: number
  labelY: number
}

const ordinal = (n: number) => {
  const tail = n % 100
  if (tail >= 11 && tail <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
}

/** Elbow paths from the advisor node (or the Lead card's advisor marks on a phone) down the map's right edge into each worker
 * that asked it. jsdom has no layout, so tests stub getBoundingClientRect. */
function measureLinks(map: HTMLElement, workers: WorkerNode[]): AdvisorLink[] {
  const origin = map.getBoundingClientRect()
  const from = map.querySelector('[data-anchor="advisor"]')
  if (!from) return []
  const a = from.getBoundingClientRect()
  const ax = a.right - origin.left
  const ay = a.top + a.height / 2 - origin.top
  const out: AdvisorLink[] = []
  let lane = 0
  for (const worker of workers) {
    if (!worker.asked) continue
    const to = map.querySelector(`[data-anchor="worker:${CSS.escape(worker.agentId)}"]`)
    if (!to) continue
    const w = to.getBoundingClientRect()
    const wx = w.right - origin.left
    const wy = w.top + w.height / 2 - origin.top
    const edge = Math.max(ax, wx) + 14 + lane * 10
    lane += 1
    const asked = worker.asked
    out.push({
      agentId: worker.agentId,
      d: `M${ax},${ay} H${edge} V${wy} H${wx}`,
      running: asked.running,
      label: asked.running
        ? `${worker.name} is asking the advisor… (${ordinal(asked.count)} time)`
        : `asked ${asked.count}×${asked.tokens > 0 ? ` · ${formatTokens(asked.tokens)} tokens` : ''}`,
      // Claude Code's own advisor call has no question (and encrypted advice): nothing to show then.
      question: asked.running ? asked.questions.at(-1) || null : null,
      labelX: edge - 8,
      labelY: wy - 8,
    })
  }
  return out
}

function Line({
  active,
  still,
  dashed,
  horizontal,
  label,
}: {
  active?: boolean
  still: boolean
  dashed?: boolean
  horizontal?: boolean
  label?: string
}) {
  return (
    <span
      className="jobmap-line"
      data-dashed={dashed ? '' : undefined}
      data-horizontal={horizontal ? '' : undefined}
      aria-hidden="true"
    >
      {label && <span className="jobmap-line-label">{label}</span>}
      {active && !still && <span className="jobmap-dot" />}
    </span>
  )
}

function Node({
  layer,
  selected,
  onPick,
  label,
  tone,
  pulse,
  children,
  className,
  anchor,
}: {
  layer: LayerId
  selected: LayerId | null
  onPick: (layer: LayerId) => void
  label: string
  tone: string
  pulse?: boolean
  children: ReactNode
  className?: string
  anchor?: string
}) {
  return (
    <button
      type="button"
      className={`jobmap-node ${className ?? ''}`}
      data-layer={layer}
      data-tone={tone}
      data-pulse={pulse ? '' : undefined}
      data-anchor={anchor}
      aria-label={label}
      aria-pressed={selected === layer}
      onClick={() => onPick(layer)}
    >
      {children}
    </button>
  )
}

function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span className="jobmap-pill" data-tone={tone}>
      {children}
    </span>
  )
}

function WorkerBox({
  worker,
  agent,
  selected,
  onPick,
}: {
  worker: WorkerNode
  agent: AgentSummary | undefined
  selected: LayerId | null
  onPick: (layer: LayerId) => void
}) {
  // A long job stays readable: the latest 12 steps as chips, the rest counted (review: 40 chips made a tall node).
  const shown = worker.chips.slice(-CHIP_LIMIT)
  const hidden = worker.chips.length - shown.length
  const counts = new Map<string, number>()
  for (const chip of worker.chips)
    counts.set(visualLabel[chip.visual], (counts.get(visualLabel[chip.visual]) ?? 0) + 1)
  const states = [...counts].map(([label, n]) => `${n} ${label}`)
  const asked = worker.asked
  return (
    <div className="jobmap-worker" data-asked={asked ? '' : undefined}>
      <Node
        layer="workers"
        selected={selected}
        onPick={onPick}
        tone="work"
        anchor={`worker:${worker.agentId}`}
        pulse={worker.running}
        label={`Workers layer: ${worker.name}, steps ${states.join(', ')}${asked ? `, asked the advisor ${asked.count} times` : ''}`}
      >
        <span className="jobmap-kicker">
          {agent && <AgentGlyph agent={agent} size="xs" bare decorative />}
          Worker · {worker.name}
        </span>
        <span className="jobmap-chips">
          {hidden > 0 && <Pill tone="muted">+{hidden} earlier</Pill>}
          {shown.map((chip) => (
            <Pill key={chip.stepId} tone={chip.tone}>
              {chip.label}
            </Pill>
          ))}
        </span>
        {asked && (
          <span className="jobmap-asked">
            asked the advisor {asked.count}×
            {asked.tokens > 0 ? ` (${formatTokens(asked.tokens)} tokens)` : ''}
          </span>
        )}
      </Node>
    </div>
  )
}

export interface JobMapViewProps {
  run: OrchestrationDetail
  events: readonly OrchEvent[]
  agents: readonly AgentSummary[]
  stop: StopStepAction
  now: number
}

/** The graph for one job, from data already loaded (the live wrapper below fetches it). */
export function JobMapView({ run, events, agents, stop, now }: JobMapViewProps) {
  const phone = useMediaQuery(PHONE_QUERY)
  const still = usePrefersReducedMotion()
  const frame = useFramed()
  const [selected, setSelected] = useState<LayerId | null>(null)
  const model: JobMapModel = useMemo(() => buildJobMap(run, events, agents), [run, events, agents])
  const has = (layer: LayerId) => model.layers.includes(layer)
  const pick = (layer: LayerId) => setSelected((current) => (current === layer ? null : layer))
  const agentOf = (id: string) => agents.find((agent) => agent.id === id)
  const lines = logFor(model, selected, { phone })
  const mapRef = useRef<HTMLElement>(null)
  const [links, setLinks] = useState<AdvisorLink[]>([])
  const { lead, advisor } = model
  const leadAgent = agentOf(lead.agentId)

  useLayoutEffect(() => {
    const map = mapRef.current
    if (!map) return
    const measure = () => {
      const next = measureLinks(map, model.workers)
      setLinks((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(map)
    return () => observer.disconnect()
  }, [model, phone])

  const stuck = run.stepsList.filter(
    (step) =>
      !step.role &&
      quietMinutes(
        step,
        run.attempts.findLast((a) => a.stepId === step.id),
        now,
      ) !== null,
  )
  // Stop for the steps that run now (a queued step has its Stop in the Steps view): one row each, not one per queued step.
  const stoppable = run.stepsList.filter(
    (step) =>
      !step.role && step.status === 'admitted' && canStopStep(step) && !stuck.includes(step),
  )
  const nameOfAgent = (id: string) => agentOf(id)?.name || id

  const marks = advisor && (
    <span className="jobmap-marks">
      {advisor.marks.map((mark) => (
        <Fragment key={mark.key}>
          <span title={mark.used ? 'asked' : 'not yet'}>
            {mark.used ? '◆' : '◇'} {mark.label}
          </span>
        </Fragment>
      ))}
    </span>
  )
  const advisorCount =
    advisor &&
    `${advisor.consults} ${advisor.consults === 1 ? 'consult' : 'consults'}${advisor.tokens > 0 ? ` · tokens read ${formatTokens(advisor.tokens)}` : ''}`

  return (
    <section
      ref={mapRef}
      className={`jobmap${phone ? ' jobmap--phone' : ''}${still ? ' jobmap--still' : ''}`}
      aria-label="Job map"
    >
      {links.length > 0 && (
        <svg className="jobmap-links" aria-hidden="true" focusable="false">
          {links.map((link) => (
            <g key={link.agentId} className="jobmap-link" data-live={link.running ? '' : undefined}>
              <path d={link.d} />
              {link.running && !still && (
                <circle r="4" className="jobmap-link-dot">
                  <animateMotion dur="2.4s" repeatCount="indefinite" path={link.d} />
                </circle>
              )}
              <text x={link.labelX} y={link.labelY} textAnchor="end">
                {link.label}
              </text>
              {link.question && (
                <text
                  x={link.labelX}
                  y={link.labelY + 15}
                  textAnchor="end"
                  className="jobmap-link-q"
                >
                  {link.question}
                </text>
              )}
            </g>
          ))}
        </svg>
      )}
      <div className="jobmap-row jobmap-top">
        <Node
          layer="you"
          selected={selected}
          onPick={pick}
          tone="you"
          label="You layer: the prompt"
          className="jobmap-you"
        >
          <span className="jobmap-kicker">You · one prompt</span>
          <span className="jobmap-two-lines">{model.goal}</span>
        </Node>
        <Line horizontal={!phone} active={lead.working} still={still} />
        <Node
          layer="lead"
          selected={selected}
          onPick={pick}
          tone="lead"
          pulse={lead.working && !still}
          label={`Lead layer: ${lead.name}, turn ${lead.turn} of ${lead.maxTurns}, ${lead.working ? 'working' : lead.doing}`}
          className="jobmap-lead"
        >
          <span className="jobmap-kicker">
            {leadAgent && <AgentGlyph agent={leadAgent} size="xs" bare decorative />}
            Lead · {lead.name}
          </span>
          <strong>
            Turn {lead.turn} of {lead.maxTurns} · {lead.doing}
          </strong>
          <span className="jobmap-sub">{lead.progress}</span>
          {phone && advisor && (
            <span className="jobmap-sub jobmap-phone-advisor" data-anchor="advisor">
              Advisor · {advisor.name}
              {marks}
              {advisorCount}
            </span>
          )}
        </Node>
        {!phone && advisor && (
          <>
            <Line horizontal dashed still label="on call" />
            <Node
              layer="advisor"
              selected={selected}
              onPick={pick}
              tone="advisor"
              pulse={advisor.working && !still}
              label={`Advisor layer: ${advisor.name}, ${advisor.mode === 'on_call' ? 'on call to the workers' : 'checkpoints only'}, ${advisorCount}`}
              className="jobmap-advisor"
              anchor="advisor"
            >
              <span className="jobmap-kicker">Advisor · {advisor.name}</span>
              {marks}
              <span className="jobmap-sub">{advisorCount}</span>
            </Node>
          </>
        )}
      </div>

      {has('votes') && model.votes && (
        <>
          <Line active={model.votes.voting} still={still} />
          <Node
            layer="votes"
            selected={selected}
            onPick={pick}
            tone="votes"
            pulse={model.votes.voting && !still}
            label={`Fork layer: ${model.votes.rows.length} recent votes, ${model.votes.rows.map((v) => `${v.question} ${v.label}`).join('; ')}`}
            className="jobmap-votes"
          >
            <span className="jobmap-kicker">Fork layer · votes</span>
            {model.votes.rows.map((vote) => (
              <span className="jobmap-vote" key={vote.id} data-status={vote.status}>
                <span className="jobmap-vote-q">{vote.question}</span>
                <span className="jobmap-bar">
                  <span style={{ width: `${Math.round(vote.share * 100)}%` }} />
                </span>
                <b>{vote.label}</b>
              </span>
            ))}
          </Node>
        </>
      )}

      {has('swarm') && model.swarm && (
        <>
          <Line active={model.active.has('swarm')} still={still} label="delegate to the swarm" />
          {model.swarm.length === 0 ? (
            <p className="jobmap-empty">No helper work yet.</p>
          ) : (
            <div className="jobmap-swarm">
              {model.swarm.map((node) => (
                <Node
                  key={node.agentId}
                  layer="swarm"
                  selected={selected}
                  onPick={pick}
                  tone="swarm"
                  pulse={node.running && !still}
                  label={`Swarm layer: ${node.name}, ${node.role}, ${node.tone === 'done' ? 'done' : node.tone === 'run' ? 'working' : node.visual}`}
                >
                  <span className="jobmap-swarm-head">
                    <b>{node.name}</b>
                    <Pill tone={node.tone}>
                      {node.tone === 'run'
                        ? 'working'
                        : node.tone === 'done'
                          ? 'done'
                          : node.visual}
                    </Pill>
                  </span>
                  <span className="jobmap-role">{node.role}</span>
                  <span className="jobmap-sub">
                    {node.lastSign ? `last sign of life ${node.lastSign}` : 'no sign yet'}
                  </span>
                </Node>
              ))}
            </div>
          )}
          <Line still label="back to the lead · findings" />
        </>
      )}

      {has('workers') && (
        <>
          {!has('swarm') && <Line active={model.active.has('workers')} still={still} />}
          <div className="jobmap-workers">
            {model.workers.map((worker) => (
              <WorkerBox
                key={worker.agentId}
                worker={worker}
                agent={agentOf(worker.agentId)}
                selected={selected}
                onPick={pick}
              />
            ))}
          </div>
          {(stuck.length > 0 || stoppable.length > 0) && (
            <div
              className="bold-run-classic jobmap-stops"
              data-tone="for-you"
              data-pack="score"
              data-theme={frame?.look ?? 'dark'}
            >
              {stuck.map((step) => (
                <StuckStepCard
                  key={step.id}
                  step={step}
                  run={run}
                  agentName={nameOfAgent(step.agentId)}
                  stop={stop}
                  now={now}
                />
              ))}
              {stoppable.map((step) => (
                <div className="jobmap-stop-line" key={step.id}>
                  <span>
                    {step.id} · {nameOfAgent(step.agentId)}
                  </span>
                  <StepStopButton step={step} run={run} stop={stop} now={now} />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {has('check') && model.check && (
        <>
          <Line active={model.active.has('check')} still={still} />
          <Node
            layer="check"
            selected={selected}
            onPick={pick}
            tone="check"
            pulse={model.check.running && !still}
            label={`Check layer: ${model.check.command}, ${model.check.outcome ?? 'not run yet'}`}
            className="jobmap-check"
          >
            <span className="jobmap-kicker">Check · runs the code, not an opinion</span>
            <span className="jobmap-check-line">
              <code>{model.check.command}</code>
              <Pill tone={model.check.tone}>
                {model.check.outcome ? `${model.check.outcome} · ${model.check.at}` : 'not run yet'}
              </Pill>
            </span>
          </Node>
        </>
      )}

      <section className="jobmap-log" aria-label="Session log">
        <header>
          <h3>Session log{selected ? ` · ${LAYER_LABEL[selected]}` : ''}</h3>
          {selected && (
            <button type="button" className="jobmap-clear" onClick={() => setSelected(null)}>
              Show everything
            </button>
          )}
        </header>
        {lines.length === 0 ? (
          <p className="jobmap-empty">Nothing here yet.</p>
        ) : (
          <ol>
            {lines.map((line) => (
              <li key={line.id}>
                <time dateTime={line.at}>{clockOf(line.at)}</time>
                <b data-layer={line.layer}>{LAYER_LABEL[line.layer]}</b>
                <span>{line.text}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  )
}

/** The job map for a running or finished lead-decides job. */
export function JobMap({ orchestrationId }: { orchestrationId: string }) {
  const run = useRun(orchestrationId)
  const agents = useStreamQuery(taskAgentsQuery).data ?? []
  const actions = useRunActions(orchestrationId)
  const detail = run.data?.snapshot.orchestration
  const now = useNow(detail !== undefined)
  if (run.isError)
    return (
      <p role="alert">
        Couldn’t load this job.{' '}
        <button type="button" onClick={() => void run.refetch()}>
          Try again
        </button>
      </p>
    )
  if (!detail || !run.data) return <p role="status">Loading the job…</p>
  return (
    <JobMapView
      run={detail}
      events={run.data.events}
      agents={agents}
      stop={actions.stopStep}
      now={now}
    />
  )
}
