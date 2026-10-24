import type { AgentSummary, Exchange, Job } from '@score/contract'
import { useMemo } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { useStreamQuery } from '../../data/query-client.ts'
import { agentNameColor } from '../bold-agents.ts'
import { exchangeStatus, exchangeTurns, type JobFilter, jobMatchesFilter } from './room-model.ts'
import { jobExchangesQuery } from './room-queries.ts'

function Capsule({
  exchange,
  agents,
}: {
  exchange: Exchange
  agents: AgentSummary[]
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
    </article>
  )
}

function JobCapsule({
  job,
  agents,
}: {
  job: Job
  agents: AgentSummary[]
}) {
  const definition = useMemo(() => jobExchangesQuery(job.id), [job.id])
  const exchanges = useStreamQuery(definition).data ?? []
  const latest = exchanges.at(-1)
  if (!latest) return null
  return <Capsule exchange={latest} agents={agents} />
}

/** The prototype's exchange capsules: who is working with whom, and how the round is going. */
export function RoomCapsules({
  jobs,
  agents,
  selectedJob,
  filter,
}: {
  jobs: Job[]
  agents: AgentSummary[]
  selectedJob: string
  filter: JobFilter
}) {
  const shown = jobs.filter(
    (job) => jobMatchesFilter(job, filter) && (selectedJob === 'all' || job.id === selectedJob),
  )
  return (
    <div className="bold-capsules" aria-label="Exchanges">
      {shown.map((job) => (
        <JobCapsule key={job.id} job={job} agents={agents} />
      ))}
    </div>
  )
}

