import { useState } from 'react'
import type { AgentDetail, HistoryOutcome } from '@score/contract'
import { Link } from '../../shell/framed-paths.tsx'
import { attemptPath, attemptStatusLabel } from '../../routes/attempts/attempt-format.ts'
import { formatDuration } from '../../routes/reports/reports-format.ts'
import { formatMoney, useDisplayCurrency } from '../../data/currency.ts'
import { useHistory } from '../../routes/team/agent-tab-queries.ts'
import { Fail, Loading, MoreCard } from './MoreCard.tsx'

const outcomeLabels: Record<HistoryOutcome, string> = {
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
  waiting: 'Waiting',
  running: 'Running',
  unknown: 'Not confirmed as ended',
}

const FEW = 4

/** The last few runs; "All runs" lists every loaded page in place. */
export function RunsCard({ agent }: { agent: AgentDetail }) {
  const [outcome, setOutcome] = useState<HistoryOutcome | ''>('')
  // The unfiltered list tells which outcomes exist; the filter itself goes to the server so older pages are included.
  const everything = useHistory(agent.id, '', '')
  const history = useHistory(agent.id, '', outcome)
  const currency = useDisplayCurrency()
  const [all, setAll] = useState(false)
  const present = new Set(
    (everything.data?.pages.flatMap((page) => page.items) ?? []).map((run) => run.outcome),
  )
  if (outcome) present.add(outcome)
  const pills = (Object.keys(outcomeLabels) as HistoryOutcome[]).filter((key) => present.has(key))
  const items = history.data?.pages.flatMap((page) => page.items) ?? []
  const shown = all ? items : items.slice(0, FEW)
  const more = items.length > FEW || history.hasNextPage
  return (
    <MoreCard id="agent-history" title="Recent runs">
      {pills.length > 1 && (
        <div className="bold-seg" role="group" aria-label="Filter runs by outcome">
          {(['', ...pills] as (HistoryOutcome | '')[]).map((key) => (
            <button
              key={key || 'all'}
              type="button"
              className={outcome === key ? 'on' : undefined}
              aria-pressed={outcome === key}
              onClick={() => setOutcome(key)}
            >
              {key ? outcomeLabels[key] : 'All'}
            </button>
          ))}
        </div>
      )}
      {history.isPending && <Loading what="runs" />}
      {history.isError && (
        <Fail>
          Couldn’t load runs.{' '}
          <button type="button" className="link" onClick={() => void history.refetch()}>
            Try again
          </button>
        </Fail>
      )}
      {history.isSuccess && !items.length && (
        <p className="small muted">{outcome ? 'No runs with this outcome.' : 'No runs yet.'}</p>
      )}
      {shown.map((run) => (
        <div className="listrow wrap" key={run.runId}>
          <span className="grow small">
            <b>{run.title}</b>{' '}
            <span className="muted">
              {run.attempt ? attemptStatusLabel[run.attempt.status] : outcomeLabels[run.outcome]} ·{' '}
              {new Date(run.startedAt).toLocaleDateString()} · {formatDuration(run.durationSec)} ·{' '}
              {run.costUsd === null ? 'cost unknown' : formatMoney(run.costUsd, currency.data)}
            </span>
          </span>
          {run.attempt && (
            <Link className="link" to={attemptPath(run.attempt)}>
              Open run
            </Link>
          )}
          {run.replaySeq !== null && (
            <Link
              className="link"
              aria-label={`Replay ${run.title}`}
              to={`/watch/${encodeURIComponent(agent.id)}?from=${run.replaySeq}`}
            >
              Replay
            </Link>
          )}
        </div>
      ))}
      {all && history.hasNextPage && (
        <button
          type="button"
          className="link"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </button>
      )}
      {more && (
        <button
          type="button"
          className="link bold-mc-start"
          aria-expanded={all}
          onClick={() => setAll((open) => !open)}
        >
          {all ? 'Fewer runs' : 'All runs'}
        </button>
      )}
    </MoreCard>
  )
}
