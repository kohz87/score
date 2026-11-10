import type { AgentDetail } from '@score/contract'
import { attemptStatusLabel } from '../../routes/attempts/attempt-format.ts'
import { formatDuration } from '../../routes/reports/reports-format.ts'
import { useHistory } from '../../routes/team/agent-tab-queries.ts'
import { outcomeLabels, RunsCard } from '../agent-more/RunsCard.tsx'
import { OpenCard, useOpenState } from './OpenCard.tsx'

/** Recent runs (mock-up 26): the last two runs, one line each; All runs opens today's full card in place. */
export function RunsTile({ agent, initialOpen }: { agent: AgentDetail; initialOpen: boolean }) {
  const history = useHistory(agent.id, '', '')
  const [open, setOpen] = useOpenState(initialOpen)
  const items = history.data?.pages.flatMap((page) => page.items) ?? []
  return (
    <OpenCard
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      title="Recent runs"
      summary={
        history.isPending ? (
          'Loading runs…'
        ) : history.isError ? (
          'Couldn’t load runs.'
        ) : items.length ? (
          <ul className="bold-agent-lines">
            {items.slice(0, 2).map((run) => (
              <li key={run.runId}>
                {run.title} ·{' '}
                {run.attempt ? attemptStatusLabel[run.attempt.status] : outcomeLabels[run.outcome]}{' '}
                · {formatDuration(run.durationSec)}
              </li>
            ))}
          </ul>
        ) : (
          'No runs yet.'
        )
      }
      openLabel={items.length || history.hasNextPage ? 'All runs' : undefined}
      openName="All runs"
    >
      <RunsCard agent={agent} />
    </OpenCard>
  )
}
