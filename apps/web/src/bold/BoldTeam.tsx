import type { AgentSummary, WatchOverviewItem } from '@score/contract'
import { useContext, type ReactNode } from 'react'
import { Link } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { runtimeLabel } from '../components/runtime-label.ts'
import { StreamContext, useStreamQuery } from '../data/query-client.ts'
import { useMediaQuery } from '../data/use-media.ts'
import { agentsQuery } from '../routes/chat/queries.ts'
import { useNow, useTeamPause } from '../data/team-pause.ts'
import { useWatchOverview } from '../routes/watch/watch-queries.ts'
import { agentNameColor, agentStateLabel } from './bold-agents.ts'
import { BoldAddAgent } from './BoldAddAgent.tsx'
import './bold-team.css'

const PHONE = '(max-width: 860px)'

function stateColor(agent: AgentSummary): string {
  if (agent.status === 'paused') return 'var(--warn)'
  if (agent.status === 'working' || agent.status === 'waiting') return agentNameColor(agent)
  return 'var(--ink2)'
}

function engineLine(agent: AgentSummary): string {
  return runtimeLabel(agent.runtime) ?? 'Hermes'
}

function stateLine(agent: AgentSummary): string {
  const word = agentStateLabel(agent)
  const state = word.charAt(0).toUpperCase() + word.slice(1)
  return agent.activity ? `${state} · ${agent.activity}` : state
}

/** A miniature of the agent's last Watch surface; a real thumbnail replaces the drawn one when Score has it. */
function ScreenGlimpse({
  agent,
  item,
}: {
  agent: AgentSummary
  item: WatchOverviewItem | undefined
}) {
  if (!item?.surface) return null
  return (
    <span
      className="thumb bold-glimpse"
      data-surface={item.surface}
      role="img"
      aria-label={`${agent.id}’s screen: ${item.surface}`}
    >
      {item.thumbnail ? (
        <img src={item.thumbnail} alt="" />
      ) : (
        <>
          <span style={{ background: agent.style.color, width: '76%' }} />
          <span style={{ width: '54%' }} />
          <span style={{ background: agent.style.color, width: '34%' }} />
        </>
      )}
    </span>
  )
}

function AgentCard({
  agent,
  watch,
}: {
  agent: AgentSummary
  watch: WatchOverviewItem | undefined
}) {
  const working = agent.status === 'working' && watch?.live === true
  return (
    <article className="agentcard bold-agentcard">
      <div className="bold-agentcard-top">
        {working ? (
          <span className="glow bold-agentcard-glow">
            <AgentGlyph agent={agent} size="lg" decorative />
          </span>
        ) : (
          <AgentGlyph agent={agent} size="lg" decorative />
        )}
        <ScreenGlimpse agent={agent} item={watch} />
      </div>
      <div className="bold-agentcard-name">
        <Link to={`/b/team/${encodeURIComponent(agent.id)}`}>{agent.id}</Link>
        <span className="small muted">{agent.role || 'No role set'}</span>
      </div>
      <span className="bold-agentcard-state" style={{ color: stateColor(agent) }}>
        {stateLine(agent)}
      </span>
      <span className="bold-agentcard-engine small muted">{engineLine(agent)}</span>
      <div className="bold-agentcard-actions">
        <Link className="btn sm primary" to={`/b?with=${encodeURIComponent(agent.id)}`}>
          Message
        </Link>
        <Link className="btn sm" to={`/b/team/${encodeURIComponent(agent.id)}`}>
          Open
        </Link>
      </div>
    </article>
  )
}

/** PLAN 11.8b: the Team page on the bold shell, rebuilt from prototype.html's vTeam(). */
export function BoldTeam() {
  const phone = useMediaQuery(PHONE)
  const agents = useStreamQuery(agentsQuery)
  const context = useContext(StreamContext)
  const watch = useWatchOverview()
  const now = useNow()
  const pause = useTeamPause()
  const visible = agents.data?.filter((agent) => agent.lifecycle?.state !== 'removed') ?? []
  const watchByAgent = new Map((watch.items ?? []).map((item) => [item.agent.id, item]))
  const paused = now.data?.paused ?? false

  let body: ReactNode
  if (agents.status === 'pending' && !agents.data)
    body = (
      <p className="bold-team-status" role="status">
        Loading agents…
      </p>
    )
  else if (agents.status === 'error')
    body = (
      <section className="card bold-team-status" role="alert">
        <h2>Couldn’t load the team</h2>
        <p className="muted">Check that the Score server is running, then try again.</p>
        <button
          type="button"
          className="btn sm"
          onClick={() => void context?.queries.register(agentsQuery).refetch()}
        >
          Try again
        </button>
      </section>
    )
  else if (visible.length === 0)
    body = (
      <section className="card bold-team-status">
        <h2>No agents yet</h2>
        <p className="muted">Agents you add will appear here. Start with Add agent.</p>
      </section>
    )
  else
    body = (
      <div className="grid4 bold-team-grid">
        {visible.map((agent) => (
          <AgentCard key={agent.id} agent={agent} watch={watchByAgent.get(agent.id)} />
        ))}
      </div>
    )

  return (
    <section className="page bold-team" aria-labelledby="bold-team-title">
      <div className="pagehead">
        <h1 className="big grow" id="bold-team-title">
          {phone ? 'Team' : 'Your team'}
        </h1>
        <BoldAddAgent agents={visible} phone={phone} />
      </div>
      {body}
      <div className="card row wrap bold-pause">
        <span className="grow">
          <b>Pause everyone</b>{' '}
          <span className="muted">
            · agents finish their current step, then wait until you resume
          </span>
        </span>
        <button
          type="button"
          className={`btn ${paused ? 'primary' : 'ghost'}`}
          disabled={pause.isPending || !now.data}
          onClick={() => pause.mutate({ paused: !paused })}
        >
          {paused ? 'Resume everyone' : 'Pause everyone'}
        </button>
        {pause.error && (
          <p className="bold-team-error" role="alert">
            Couldn’t {paused ? 'resume' : 'pause'} the team. Try again.
          </p>
        )}
      </div>
    </section>
  )
}
