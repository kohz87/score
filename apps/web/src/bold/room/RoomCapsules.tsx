import type { AgentSummary, Exchange, Job } from '@score/contract'
import { useMemo } from 'react'
import { useNavigate } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { useStreamQuery } from '../../data/query-client.ts'
import { agentNameColor } from '../bold-agents.ts'
import { boldAsideLink } from '../bold-links.ts'
import { exchangeStatus, exchangeTurns, type JobFilter, jobMatchesFilter } from './room-model.ts'
import { jobExchangesQuery } from './room-queries.ts'
import { currentExchange } from './thread-model.ts'

function Capsule({
  exchange,
  agents,
  job,
  onOpenThread,
}: {
  exchange: Exchange
  agents: AgentSummary[]
  job: Job
  onOpenThread: (jobId: string) => void
}) {
  const from = agents.find((agent) => agent.id === exchange.from)
  const to = agents.find((agent) => agent.id === exchange.to)
  const paused = Boolean(exchange.pause)
  return (
    <article
      className={`bold-capsule${paused ? ' is-paused' : ''}`}
      aria-label={`${exchange.kind} between ${exchange.from} and ${exchange.to}`}
    >
      <span className="bold-capsule-head">
        <span className="bold-capsule-faces" aria-hidden="true">
          {from && <AgentGlyph agent={from} size="xs" decorative />}
          {to && <AgentGlyph agent={to} size="xs" decorative />}
        </span>
        <b style={from ? { color: agentNameColor(from) } : undefined}>{exchange.from}</b>
        <span className="muted">and</span>
        <b style={to ? { color: agentNameColor(to) } : undefined}>{exchange.to}</b>
        <span className="bold-capsule-status">{exchangeStatus(exchange)}</span>
      </span>
      <span className="small muted">
        {exchange.kind} · {exchangeTurns(exchange)}
        {exchange.parentId ? ' · follow-up' : ''}
      </span>
      {exchange.queuedBehind && (
        <span className="small muted">
          Waiting for {exchange.queuedBehind.agentId} in another job
        </span>
      )}
      <span className="bold-capsule-actions">
        <button
          type="button"
          className="bold-capsule-thread"
          aria-label={`Open thread for ${job.title}`}
          onClick={() => onOpenThread(job.id)}
        >
          Open thread
        </button>
      </span>
    </article>
  )
}

function JobCapsule({
  job,
  agents,
  onOpenThread,
}: {
  job: Job
  agents: AgentSummary[]
  onOpenThread: (jobId: string) => void
}) {
  const definition = useMemo(() => jobExchangesQuery(job.id), [job.id])
  const exchanges = useStreamQuery(definition).data ?? []
  const navigate = useNavigate()
  const latest = currentExchange(exchanges)
  if (!latest) return null
  const asideAgent = agents.find((agent) => agent.id === latest.from)

  // The chat is made when the first message is sent, so looking and walking away leaves nothing behind.
  function takeAside() {
    if (asideAgent) void navigate(boldAsideLink(asideAgent.id, job.id))
  }

  return (
    <div className="bold-capsule-wrap">
      <Capsule exchange={latest} agents={agents} job={job} onOpenThread={onOpenThread} />
      {asideAgent && (
        <span className="bold-capsule-aside-row">
          <button
            type="button"
            className="chip bold-capsule-aside"
            style={{ color: agentNameColor(asideAgent) }}
            onClick={takeAside}
          >
            {`Take it aside with ${asideAgent.id}`}
          </button>
        </span>
      )}
    </div>
  )
}

/** The prototype's exchange capsules: who is working with whom, and how the round is going. */
export function RoomCapsules({
  jobs,
  agents,
  selectedJob,
  filter,
  onOpenThread,
}: {
  jobs: Job[]
  agents: AgentSummary[]
  selectedJob: string
  filter: JobFilter
  onOpenThread: (jobId: string) => void
}) {
  const shown = jobs.filter(
    (job) => jobMatchesFilter(job, filter) && (selectedJob === 'all' || job.id === selectedJob),
  )
  return (
    <div className="bold-capsules" aria-label="Exchanges">
      {shown.map((job) => (
        <JobCapsule key={job.id} job={job} agents={agents} onOpenThread={onOpenThread} />
      ))}
    </div>
  )
}
