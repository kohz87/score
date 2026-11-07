import type { AgentSummary, OrchEvent, OrchestrationDetail } from '@score/contract'
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { useFramed } from '../../shell/framed-paths.tsx'
import {
  buildJobMap,
  LAYER_LABEL,
  logFor,
  type LayerId,
  type JobMapModel,
} from './job-map-model.ts'
import { Line } from './Line.tsx'
import { Node } from './Node.tsx'
import { Pill } from './Pill.tsx'
import { WorkerBox } from './WorkerBox.tsx'
import './jobmap.css'

// 3.15 (decision 151): the job's main view is a layered graph, rebuilt from docs/design/jobmap/graph-desktop.html and
// graph-phone.html with the bold tokens. Each layer is one node that summarises itself; layers a job doesn't use are not
// drawn. The session log under it doubles as the text alternative of the graph.

const clockOf = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** The desktop top row's width plus room to breathe: you 260 + line 48 + lead 320, and + line 64 + advisor 320. */
const TOP_ROW_WIDTH = { lead: 700, advisor: 1060 }

export interface JobMapViewProps {
  run: OrchestrationDetail
  events: readonly OrchEvent[]
  agents: readonly AgentSummary[]
  stop: StopStepAction
  now: number
}

/** The graph for one job, from data already loaded (the live wrapper below fetches it). */
export function JobMapView({ run, events, agents, stop, now }: JobMapViewProps) {
  const phoneScreen = useMediaQuery(PHONE_QUERY)
  // 3.27.1 (owner's Troubleshooting note): the map stacks by its own width, not the screen's. In the chat's 420px Graph
  // panel or a narrow sheet the side-by-side top row (you · lead · advisor, about 1020px) wrapped into a muddle.
  const box = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(0)
  // Measured before paint, so the panel never flashes the side-by-side row (3.27.1 review).
  useLayoutEffect(() => {
    const element = box.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const measure = () => setWidth(element.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const still = usePrefersReducedMotion()
  const frame = useFramed()
  const [selected, setSelected] = useState<LayerId | null>(null)
  const model: JobMapModel = useMemo(() => buildJobMap(run, events, agents), [run, events, agents])
  const topRow = model.advisor ? TOP_ROW_WIDTH.advisor : TOP_ROW_WIDTH.lead
  const phone = phoneScreen || (width > 0 && width < topRow)
  const has = (layer: LayerId) => model.layers.includes(layer)
  const pick = (layer: LayerId) => setSelected((current) => (current === layer ? null : layer))
  const agentOf = (id: string) => agents.find((agent) => agent.id === id)
  const lines = logFor(model, selected, { phone })
  const { lead, advisor } = model
  const leadAgent = agentOf(lead.agentId)

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
    advisor && `${advisor.consults} ${advisor.consults === 1 ? 'consult' : 'consults'}`

  return (
    <section
      ref={box}
      className={`jobmap${phone ? ' jobmap--phone' : ''}${still ? ' jobmap--still' : ''}`}
      aria-label="Job map"
    >
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
          label={`Lead layer: ${lead.name}, turn ${lead.turn}${lead.untilStopped ? ', until you stop it' : ` of ${lead.maxTurns}`}, ${lead.working ? 'working' : lead.doing}`}
          className="jobmap-lead"
        >
          <span className="jobmap-kicker">
            {leadAgent && <AgentGlyph agent={leadAgent} size="xs" bare decorative />}
            Lead · {lead.name}
          </span>
          <strong>
            Turn {lead.turn}
            {lead.untilStopped ? ' · until you stop it' : ` of ${lead.maxTurns}`} · {lead.doing}
          </strong>
          <span className="jobmap-sub">{lead.progress}</span>
          {phone && advisor && (
            <span className="jobmap-sub jobmap-phone-advisor">
              Advisor · {advisor.name}
              {marks}
              {advisorCount}
            </span>
          )}
        </Node>
        {!phone && advisor && (
          <>
            <Line horizontal dashed still label="checkpoints" />
            <Node
              layer="advisor"
              selected={selected}
              onPick={pick}
              tone="advisor"
              pulse={advisor.working && !still}
              label={`Advisor layer: ${advisor.name}, ${advisorCount}`}
              className="jobmap-advisor"
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
