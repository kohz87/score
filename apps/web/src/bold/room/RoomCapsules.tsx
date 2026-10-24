import type { AgentSummary, Exchange, Job } from '@score/contract'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { useStreamQuery } from '../../data/query-client.ts'
import { agentNameColor } from '../bold-agents.ts'
import { boldChatRefLink, boldJobLink } from '../bold-links.ts'
import { createDirectChat } from '../direct/direct-queries.ts'
import { exchangeStatus, exchangeTurns, type JobFilter, jobMatchesFilter } from './room-model.ts'
import { jobExchangesQuery } from './room-queries.ts'

function Capsule({ exchange, agents }: { exchange: Exchange; agents: AgentSummary[] }) {
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

function JobCapsule({ job, agents }: { job: Job; agents: AgentSummary[] }) {
  const definition = useMemo(() => jobExchangesQuery(job.id), [job.id])
  const exchanges = useStreamQuery(definition).data ?? []
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latest = exchanges.at(-1)
  if (!latest) return null
  const asideAgent = agents.find((agent) => agent.id === latest.from)

  async function takeAside() {
    if (!asideAgent) return
    setBusy(true)
    setError(null)
    try {
      const chat = await createDirectChat(asideAgent.id, job.title)
      void navigate(boldChatRefLink(asideAgent.id, chat.id, job.id))
    } catch {
      setError('Couldn’t start a private chat. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bold-capsule-wrap">
      <Capsule exchange={latest} agents={agents} />
      {asideAgent && (
        <span className="bold-capsule-actions">
          <button type="button" className="chip" onClick={() => void navigate(boldJobLink(job.id))}>
            Open thread
          </button>
          <button
            type="button"
            className="chip bold-capsule-aside"
            style={{ color: agentNameColor(asideAgent) }}
            disabled={busy}
            onClick={() => void takeAside()}
          >
            {busy ? 'Opening…' : `Take it aside with ${asideAgent.id}`}
          </button>
        </span>
      )}
      {error && (
        <p className="small bold-request-error" role="alert">
          {error}
        </p>
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
