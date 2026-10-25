import { useState } from 'react'
import type { AgentDetail, HistoryOutcome } from '@score/contract'
import { Link } from '../../shell/framed-paths.tsx'
import { attemptPath, attemptStatusLabel } from '../../routes/attempts/attempt-format.ts'
import { formatDuration } from '../../routes/reports/reports-format.ts'
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
  const history = useHistory(agent.id, '', '')
  const [all, setAll] = useState(false)
  const items = history.data?.pages.flatMap((page) => page.items) ?? []
  const shown = all ? items : items.slice(0, FEW)
  const more = items.length > FEW || history.hasNextPage
  return (
    <MoreCard id="agent-history" title="Recent runs">
      {history.isPending && <Loading what="runs" />}
      {history.isError && (
        <Fail>
          Couldn’t load runs.{' '}
          <button type="button" className="link" onClick={() => void history.refetch()}>
            Try again
          </button>
        </Fail>
      )}
      {history.isSuccess && !items.length && <p className="small muted">No runs yet.</p>}
      {shown.map((run) => (
        <div className="listrow wrap" key={run.runId}>
          <span className="grow small">
            <b>{run.title}</b>{' '}
            <span className="muted">
              {run.attempt ? attemptStatusLabel[run.attempt.status] : outcomeLabels[run.outcome]} ·{' '}
              {new Date(run.startedAt).toLocaleDateString()} · {formatDuration(run.durationSec)}
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
