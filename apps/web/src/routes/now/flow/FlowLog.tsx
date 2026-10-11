import { useState } from 'react'
import type { AgentSummary, BriefFlow } from '@score/contract'
import { Link } from 'react-router'
import { AgentGlyph } from '../../../components/AgentGlyph.tsx'
import { agentTextColor } from '../../chat/agent-text-color.ts'
import { duration } from './FlowInspector.tsx'
import { useBriefLog } from './flow-queries.ts'

export function FlowLog({ briefId, agents }: { briefId: string; agents: AgentSummary[] }) {
  const [filter, setFilter] = useState('all')
  const log = useBriefLog(briefId, filter)
  const lines = [
    ...new Map(
      log.data?.pages.flatMap((page) => page.items).map((line) => [line.id, line]),
    ).values(),
  ]
  return (
    <section className="flow-log" aria-label="Live log">
      <div className="flow-log__heading">
        <h2>Live log</h2>
        <span className="flow-log__live">Live updates</span>
        <div className="flow-log__filters" role="group" aria-label="Log filters">
          {[
            { id: 'all', name: 'Everyone' },
            ...agents.map((agent) => ({ id: `agent:${agent.id}`, name: agent.name })),
            { id: 'tool', name: 'Tool calls' },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.name}
            </button>
          ))}
        </div>
      </div>
      {log.isError && (
        <p role="alert">
          Couldn’t load the log.{' '}
          <button type="button" onClick={() => void log.refetch()}>
            Try again
          </button>
        </p>
      )}
      {log.isPending && <p role="status">Loading log…</p>}
      <div
        className="flow-log__lines"
        role="log"
        aria-label="Run activity"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {lines.map((line) => {
          const agent =
            agents.find((item) => item.id === line.agentId) ??
            (line.agentId && line.agentId !== 'you'
              ? {
                  id: line.agentId,
                  name: line.agentId,
                  style: { color: '#9AA0AB', shape: 'circle-dot' as const },
                }
              : undefined)
          return (
            <div key={line.id} className="flow-log__line">
              <time dateTime={line.at}>
                {new Date(line.at).toLocaleTimeString([], { hour12: false })}
              </time>
              <span
                className="flow-log__agent"
                style={{ color: agentTextColor(agent?.style.color ?? '#9AA0AB') }}
              >
                {agent && <AgentGlyph agent={agent} size="xs" decorative />}
                {agent?.name ?? line.agentId ?? 'System'}
              </span>
              <span>{line.text}</span>
            </div>
          )
        })}
        {log.isSuccess && lines.length === 0 && <p>No log entries for this filter.</p>}
      </div>
      {log.hasNextPage && (
        <button
          type="button"
          className="flow-log__more"
          disabled={log.isFetchingNextPage}
          onClick={() => void log.fetchNextPage()}
        >
          Load more
        </button>
      )}
    </section>
  )
}

export function FlowStats({ stats }: { stats: BriefFlow['stats'] }) {
  return (
    <section className="flow-stats" aria-label="This run so far">
      <h2>This run so far</h2>
      <dl>
        {[
          [duration(stats.runningSec), 'running'],
          [stats.steps, 'steps taken'],
          [stats.handoffs, 'hand-offs'],
          [
            stats.spendUsd !== null
              ? `$${stats.spendUsd.toFixed(2)}`
              : // Kanban attempts record no cost, so the total would understate what was spent.
                (stats.attempts ?? 0) > 0
                ? 'partial'
                : '—',
            'model spend',
          ],
        ].map(([value, label]) => (
          <div key={label}>
            <dd>{value}</dd>
            <dt>{label}</dt>
          </div>
        ))}
      </dl>
      <p>
        ETA <b>{stats.eta ?? '—'}</b>
      </p>
      <Link to="/reports">See all runs in Reports</Link>
    </section>
  )
}
