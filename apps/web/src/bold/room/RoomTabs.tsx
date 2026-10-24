import type { Job } from '@score/contract'
import type { ReactNode } from 'react'
import { ThreadIcon } from '../BoldIcons.tsx'
import { JOB_FILTERS, jobMatchesFilter, jobStateLabel, type JobFilter } from './room-model.ts'
import type { JobRead } from './room-queries.ts'

function jobDot(state: Job['state']) {
  if (state === 'working') return 'var(--ok)'
  if (state === 'waiting_on_you') return 'var(--bad)'
  if (state === 'done') return 'var(--ok)'
  if (state === 'closed') return 'var(--faint)'
  return 'var(--muted)'
}

/** Job tabs and the D10 filter chips. The room's default job is the unlabelled bin for new work, not a tab. */
export function RoomTabs({
  jobs,
  selectedJob,
  filter,
  onSelectJob,
  onSelectFilter,
  trailing,
  onOpenThread,
}: {
  jobs: JobRead[]
  selectedJob: string
  filter: JobFilter
  onSelectJob: (jobId: string) => void
  onSelectFilter: (filter: JobFilter) => void
  trailing?: ReactNode
  onOpenThread?: (jobId: string) => void
}) {
  const named = jobs.filter((job) => !job.isDefault)
  const visible = named.filter((job) => jobMatchesFilter(job, filter))
  const selected = named.find((job) => job.id === selectedJob)
  // The default job is the unlabelled bin for new work; its unread count would duplicate what All already shows.
  const allUnread = named.reduce((total, job) => total + (job.unread ?? 0), 0)
  return (
    <div className="bold-room-tabs">
      <div className="bold-job-tabs" role="tablist" aria-label="Jobs">
        <button
          type="button"
          role="tab"
          aria-selected={selectedJob === 'all'}
          className={`bold-job-tab${selectedJob === 'all' ? ' on' : ''}`}
          onClick={() => onSelectJob('all')}
        >
          All
          {allUnread > 0 && (
            <span className="bold-unread" aria-label={`${allUnread} unread`}>
              {allUnread > 99 ? '99+' : allUnread}
            </span>
          )}
        </button>
        {visible.map((job) => (
          <button
            key={job.id}
            type="button"
            role="tab"
            aria-selected={selectedJob === job.id}
            className={`bold-job-tab${selectedJob === job.id ? ' on' : ''}`}
            title={`${job.title} · ${jobStateLabel(job)}`}
            onClick={() => onSelectJob(job.id)}
          >
            <span
              className={`bold-job-dot${job.state === 'working' ? ' livedot' : ''}`}
              style={{ background: jobDot(job.state) }}
              aria-hidden="true"
            />
            <span className="bold-job-name">{job.title}</span>
            {job.unread !== undefined && job.unread > 0 && (
              <span className="bold-unread" aria-label={`${job.unread} unread`}>
                {job.unread > 99 ? '99+' : job.unread}
              </span>
            )}
          </button>
        ))}
        {trailing}
      </div>
      <div className="bold-job-filters" role="group" aria-label="Filter jobs">
        {JOB_FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`bold-filter${filter === item.id ? ' on' : ''}`}
            aria-pressed={filter === item.id}
            onClick={() => onSelectFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
        {selected && onOpenThread && (
          <button
            type="button"
            className="bold-filter bold-job-thread"
            aria-label={`Open thread for ${selected.title}`}
            onClick={() => onOpenThread(selected.id)}
          >
            <ThreadIcon size={14} />
            Thread
          </button>
        )}
      </div>
    </div>
  )
}
