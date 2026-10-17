import { useState, type ReactNode } from 'react'
import type { AgentSummary, BriefFlow, LogLine } from '@score/contract'
import { Link } from 'react-router'
import { AgentGlyph } from '../../../components/AgentGlyph.tsx'
import { nestSubagentCalls, subagentLine } from '../../../components/subagent.ts'
import { agentTextColor } from '../../chat/agent-text-color.ts'
import { duration } from './FlowInspector.tsx'
import { useBriefLog } from './flow-queries.ts'
import { LiveCount } from '../../../live/LiveCount.tsx'

export function FlowLog({ briefId, agents }: { briefId: string; agents: AgentSummary[] }) {
  const [filter, setFilter] = useState('all')
  const log = useBriefLog(briefId, filter)
  const lines = [
    ...new Map(
      log.data?.pages.flatMap((page) => page.items).map((line) => [line.id, line]),
    ).values(),
  ]
  const { top, children } = nestSubagentCalls(lines)
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
        {top.map((line) => {
          const nested = line.callId ? (children.get(line.callId) ?? []) : []
          const row = (item: LogLine) => {
            const agent =
              agents.find((candidate) => candidate.id === item.agentId) ??
              (item.agentId && item.agentId !== 'you'
                ? {
                    id: item.agentId,
                    name: item.agentId,
                    style: { color: '#9AA0AB', shape: 'circle-dot' as const },
                  }
                : undefined)
            const who = (
              <span
                className="flow-log__agent"
                style={{ color: agentTextColor(agent?.style.color ?? '#9AA0AB') }}
              >
                {agent && <AgentGlyph agent={agent} size="xs" decorative />}
                {agent?.name ?? item.agentId ?? 'System'}
              </span>
            )
            const when = (
              <time dateTime={item.at}>
                {new Date(item.at).toLocaleTimeString([], { hour12: false })}
              </time>
            )
            return { who, when }
          }
          const { who, when } = row(line)
          // PLAN 8.7: a sub-agent's calls sit inside its Agent line, collapsed.
          if (line.subagent)
            return (
              <details key={line.id} className="flow-log__sub">
                <summary className="flow-log__line">
                  {when}
                  {who}
                  <span>
                    <span className="flow-log__sub-label">sub-agent</span>{' '}
                    {subagentLine(line.subagent, nested.length)}
                  </span>
                </summary>
                {nested.map((item) => {
                  const inner = row(item)
                  return (
                    <div key={item.id} className="flow-log__line flow-log__line--nested">
                      {inner.when}
                      {inner.who}
                      <span>{item.text}</span>
                    </div>
                  )
                })}
              </details>
            )
          return (
            <div key={line.id} className="flow-log__group">
              <div className="flow-log__line">
                {when}
                {who}
                <span>{line.text}</span>
              </div>
              {nested.map((item) => {
                const inner = row(item)
                return (
                  <div key={item.id} className="flow-log__line flow-log__line--nested">
                    {inner.when}
                    {inner.who}
                    <span>{item.text}</span>
                  </div>
                )
              })}
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

const money = (value: number) => `$${value.toFixed(2)}`

export function FlowStats({
  stats,
  toolCalls = null,
}: {
  stats: BriefFlow['stats']
  /** Tool calls of the run when Score has counted all of them. */
  toolCalls?: number | null
}) {
  const tiles: [ReactNode, string][] = [
    [duration(stats.runningSec), 'running'],
    [<LiveCount key="steps" value={stats.steps} />, 'steps taken'],
    [<LiveCount key="handoffs" value={stats.handoffs} />, 'hand-offs'],
    ...(toolCalls !== null && toolCalls > 0
      ? [[<LiveCount key="tools" value={toolCalls} />, 'tool calls'] as [ReactNode, string]]
      : []),
    [
      stats.spendUsd !== null ? (
        <LiveCount key="spend" value={stats.spendUsd} format={money} />
      ) : // Kanban attempts record no cost, so the total would understate what was spent.
      (stats.attempts ?? 0) > 0 ? (
        'partial'
      ) : (
        '—'
      ),
      'model spend',
    ],
  ]
  return (
    <section className="flow-stats" aria-label="This run so far">
      <h2>This run so far</h2>
      <dl>
        {tiles.map(([value, label]) => (
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
