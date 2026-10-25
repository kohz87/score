import type { AgentSummary, Job } from '@score/contract'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { agentStateLabel } from '../bold-agents.ts'
import { jobStateLabel, jobStateLine } from './room-model.ts'

function stateColor(job: Job): string {
  if (job.state === 'working' || job.state === 'done') return 'var(--ok)'
  if (job.state === 'waiting_on_you') return 'var(--bad)'
  if (job.state === 'closed') return 'var(--faint)'
  return 'var(--muted)'
}

/** The board's compact roster: every agent keeps their colour and shape, and one who needs you gets a light ring. */
export function PhonePresence({ agents }: { agents: AgentSummary[] }) {
  if (agents.length === 0) return null
  const label = agents.map((agent) => `${agent.id} ${agentStateLabel(agent)}`).join(', ')
  return (
    <span className="bold-phone-presence" role="group" aria-label={label}>
      {agents.map((agent) => (
        <span
          key={agent.id}
          className={`bold-phone-presence-agent${agent.status === 'waiting' ? ' needs' : ''}`}
          data-protected={agent.status === 'waiting' ? 'inline-flex' : undefined}
          title={`${agent.id} · ${agentStateLabel(agent)}`}
        >
          <AgentGlyph agent={agent} size="xs" bare decorative />
        </span>
      ))}
    </span>
  )
}

/**
 * Board 18: the phone's way into a job, with its holder's glyph, unread count and state. Unlike the desktop tabs, the
 * list also needs the default job: it is the visible home of the list composer's "message the team" path.
 */
export function PhoneJobList({
  jobs,
  agents,
  onOpen,
  closedOnly = false,
  onShowClosed,
}: {
  jobs: (Job & { unread?: number })[]
  agents: AgentSummary[]
  onOpen: (jobId: string) => void
  /** The phone's Closed jobs view: only closed jobs, with a way back to the live list. */
  closedOnly?: boolean
  onShowClosed?: () => void
}) {
  const defaultJob = jobs.find((job) => job.isDefault)
  const closed = jobs.filter((job) => !job.isDefault && job.state === 'closed')
  const named = closedOnly ? closed : jobs.filter((job) => !job.isDefault && job.state !== 'closed')
  const rows = !closedOnly && defaultJob ? [defaultJob, ...named] : named

  return (
    <section className="bold-phone-jobs" aria-label="Jobs">
      <div className="bold-phone-jobs-head">
        <h2>{closedOnly ? 'Closed jobs' : 'Jobs'}</h2>
        {closedOnly && onShowClosed && (
          <button type="button" className="link" onClick={onShowClosed}>
            Back to jobs
          </button>
        )}
      </div>
      {!closedOnly && closed.length > 0 && onShowClosed && (
        <button type="button" className="link bold-phone-closed-jobs" onClick={onShowClosed}>
          Closed jobs ({closed.length})
        </button>
      )}
      <div className="bold-phone-job-list">
        {rows.length === 0 && <p className="small muted">No closed jobs.</p>}
        {rows.map((job) => {
          const holder = job.holderAgentId
            ? agents.find((agent) => agent.id === job.holderAgentId)
            : undefined
          const state = jobStateLine(job, agents)
          const title = job.isDefault ? 'Team room' : job.title
          return (
            <button
              key={job.id}
              type="button"
              className="bold-phone-job"
              data-phone-job-id={job.id}
              aria-label={`${title}. ${state}${job.unread ? `, ${job.unread} unread` : ''}`}
              onClick={() => onOpen(job.id)}
            >
              {holder ? (
                <AgentGlyph agent={holder} size="lg" decorative />
              ) : (
                <span className="bold-phone-job-blank" aria-hidden="true" />
              )}
              <span className="bold-phone-job-copy">
                <span className="bold-phone-job-title">
                  <b>{title}</b>
                  {job.unread !== undefined && job.unread > 0 ? (
                    <span className="bold-unread" aria-label={`${job.unread} unread`}>
                      {job.unread > 99 ? '99+' : job.unread}
                    </span>
                  ) : (
                    <span
                      className="bold-phone-state-mark"
                      role="img"
                      aria-label={jobStateLabel(job)}
                    >
                      {job.state === 'done' ? (
                        <span className="bold-phone-state-check" aria-hidden="true">
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M5 12l5 5 9-10" />
                          </svg>
                        </span>
                      ) : (
                        <span
                          className={`bold-phone-state-dot${job.state === 'working' ? ' livedot' : ''}`}
                          style={{ background: stateColor(job) }}
                          aria-hidden="true"
                        />
                      )}
                    </span>
                  )}
                </span>
                <span className="bold-phone-job-state small muted">{state}</span>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
