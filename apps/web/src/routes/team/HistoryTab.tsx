import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import type { HistoryOutcome } from '@score/contract'
import { useStreamQuery } from '../../data/query-client.ts'
import {
  attemptEndText,
  attemptPath,
  attemptStatusLabel,
  evidenceLabel,
} from '../attempts/attempt-format.ts'
import { orchestrationsQuery } from '../orchestrations/orchestration-queries.ts'
import { formatDuration, formatUsd } from '../reports/reports-format.ts'
import { briefHasRun } from '../runs/brief-run.ts'
import { workflowRunsQuery } from '../workflows/workflow-queries.ts'
import { useHistory } from './agent-tab-queries.ts'

const outcomeLabels: Record<HistoryOutcome, string> = {
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
  waiting: 'Waiting',
  running: 'Running',
  unknown: 'Not confirmed as ended',
}

export function HistoryTab({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [outcome, setOutcome] = useState<HistoryOutcome | ''>('')
  const history = useHistory(agentId, query, outcome)
  const orchestrations = useStreamQuery(orchestrationsQuery).data ?? []
  const workflows = useStreamQuery(workflowRunsQuery).data ?? []
  const items = history.data?.pages.flatMap((page) => page.items) ?? []
  function search(event: FormEvent) {
    event.preventDefault()
    setQuery(draft.trim())
  }
  return (
    <section className="team-card" aria-labelledby="team-history-heading">
      <h2 id="team-history-heading">History</h2>
      <form className="team-search" role="search" aria-label="Search history" onSubmit={search}>
        <input
          type="search"
          aria-label="Search history"
          placeholder={`Search ${agentName}’s runs`}
          maxLength={200}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            if (!event.target.value.trim()) setQuery('')
          }}
        />
        <select
          aria-label="Outcome"
          value={outcome}
          onChange={(event) => setOutcome(event.target.value as HistoryOutcome | '')}
        >
          <option value="">All outcomes</option>
          {Object.entries(outcomeLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button type="submit">Search</button>
      </form>
      {history.isPending && <p role="status">Loading history…</p>}
      {history.isError && (
        <p role="alert">
          Couldn’t load history. <button onClick={() => void history.refetch()}>Try again</button>
        </p>
      )}
      {history.isSuccess && !items.length && (
        <p className="team-muted-strong">
          {query || outcome ? 'No runs match.' : `${agentName} has no runs yet.`}
        </p>
      )}
      <ul className="team-routine-list">
        {items.map((run) => (
          <li className="team-routine-row team-routine" key={run.runId}>
            <div className="team-routine-body">
              <p>
                <strong>{run.title}</strong>{' '}
                <span className="team-channel-state" data-outcome={run.outcome}>
                  {run.attempt
                    ? attemptStatusLabel[run.attempt.status]
                    : outcomeLabels[run.outcome]}
                </span>
              </p>
              <p className="team-muted">
                {new Date(run.startedAt).toLocaleString()} · {formatDuration(run.durationSec)}
                {run.costUsd !== null && ` · ${formatUsd(run.costUsd)}`}
                {run.model && ` · ${run.model}`}
              </p>
              {run.attempt && (
                <p className="team-muted">
                  Task run · {attemptEndText(run.attempt, (iso) => new Date(iso).toLocaleString())}
                  {run.attempt.evidence === 'partial' && ` · ${evidenceLabel.partial}`} · tools and
                  model not recorded
                </p>
              )}
              <p className="team-muted">
                {run.attempt && <Link to={attemptPath(run.attempt)}>Open this run</Link>}
                {run.attempt && run.task && ' · '}
                {run.task && <span>Task: {run.task.title}</span>}
                {run.task && run.brief && ' · '}
                {run.brief && briefHasRun(run.brief.id, orchestrations, workflows) && (
                  <Link to={`/runs/${encodeURIComponent(run.brief.id)}`}>
                    Run: {run.brief.title}
                  </Link>
                )}
              </p>
            </div>
            {run.replaySeq !== null && (
              <div className="team-routine-actions">
                <Link
                  className="team-pill-button"
                  aria-label={`Replay ${run.title} in Watch`}
                  to={`/watch/${encodeURIComponent(agentId)}?from=${run.replaySeq}`}
                >
                  Replay in Watch
                </Link>
              </div>
            )}
          </li>
        ))}
      </ul>
      {history.hasNextPage && (
        <button
          type="button"
          className="team-pill-button"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </button>
      )}
    </section>
  )
}
