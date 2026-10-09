import type { AgentSummary, Journey, JourneyKind } from '@score/contract'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import './journey-chart.css'

const WIDTH = 900
const LEFT = 8
const RIGHT = 8
const ROW = 46
const AXIS = 30

/** One shape per kind, so the marks never rely on colour (the row's glyph names the agent). */
const KINDS: { kind: JourneyKind; label: string; plural: string }[] = [
  { kind: 'task_done', label: 'Task completed', plural: 'tasks completed' },
  { kind: 'note_written', label: 'Knowledge note written', plural: 'notes written' },
  { kind: 'skill_changed', label: 'Skill changed', plural: 'skills changed' },
  { kind: 'memory_changed', label: 'Memory file changed', plural: 'memory files changed' },
]

export function MarkShape({
  kind,
  x,
  y,
  size = 6,
}: {
  kind: JourneyKind
  x: number
  y: number
  size?: number
}) {
  const s = size
  switch (kind) {
    case 'task_done':
      return <circle cx={x} cy={y} r={s} />
    case 'note_written':
      return <rect x={x - s} y={y - s} width={s * 2} height={s * 2} rx={1.5} />
    case 'skill_changed':
      return (
        <path d={`M${x} ${y - s - 1} L${x + s + 1} ${y} L${x} ${y + s + 1} L${x - s - 1} ${y} Z`} />
      )
    case 'memory_changed':
      return <path d={`M${x} ${y - s - 1} L${x + s + 1} ${y + s} L${x - s - 1} ${y + s} Z`} />
  }
}

const dayStart = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y!, m! - 1, d!).getTime()
}
const shortDate = (ms: number) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(ms)
const when = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
    Date.parse(iso),
  )

function agentFor(agents: AgentSummary[], id: string): AgentSummary {
  return (
    agents.find((agent) => agent.id === id) ?? {
      id,
      name: id,
      role: '',
      style: { color: '#9aa0ab', shape: 'circle-dot' },
      status: 'idle',
      activity: null,
      model: { id: '', label: '' },
      served: false,
    }
  )
}

/** A time axis with one row per agent. Counts and a full list give the same facts as text. */
export function JourneyChart({ journey, agents }: { journey: Journey; agents: AgentSummary[] }) {
  const start = dayStart(journey.from)
  const [ty, tm, td] = journey.to.split('-').map(Number)
  const end = new Date(ty!, tm! - 1, td! + 1).getTime()
  const plot = WIDTH - LEFT - RIGHT
  const x = (ms: number) =>
    LEFT + ((Math.min(Math.max(ms, start), end) - start) / (end - start)) * plot
  const days = Math.round((end - start) / 86_400_000)
  const every = Math.max(1, Math.ceil(days / 8))
  const ticks = Array.from({ length: Math.ceil(days / every) + 1 }, (_, i) =>
    Math.min(start + i * every * 86_400_000, end),
  )
  const total = journey.agents.reduce((sum, agent) => sum + agent.events.length, 0)
  const counts = (events: Journey['agents'][number]['events']) =>
    KINDS.map(({ kind }) => events.filter((event) => event.kind === kind).length)

  return (
    <div className="journey">
      <ul className="journey__legend" aria-label="Legend">
        {KINDS.map(({ kind, label }) => (
          <li key={kind}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <g className="journey__mark">
                <MarkShape kind={kind} x={8} y={8} />
              </g>
            </svg>
            {label}
          </li>
        ))}
      </ul>
      {journey.truncated && (
        <p className="journey__note" role="status">
          Showing the newest marks only: at most 500 per agent and 2,000 in all.
        </p>
      )}
      <div
        className="journey__scroll"
        role="region"
        aria-label="Journey chart, scroll to see all days"
        tabIndex={0}
      >
        <div
          className="journey__grid-rows"
          role="img"
          aria-label={`Journey from ${journey.from} to ${journey.to}: ${total} marks across ${journey.agents.length} agents. The table below gives the counts.`}
        >
          {journey.agents.map((row) => {
            const agent = agentFor(agents, row.id)
            return (
              <div key={row.id} className="journey__row">
                <span className="journey__name">
                  <AgentGlyph agent={agent} size="sm" decorative />
                  {agent.name}
                </span>
                <svg className="journey__svg" viewBox={`0 0 ${WIDTH} ${ROW}`} aria-hidden="true">
                  {ticks.map((tick) => (
                    <line
                      key={tick}
                      className="journey__grid"
                      x1={x(tick)}
                      x2={x(tick)}
                      y1={0}
                      y2={ROW}
                    />
                  ))}
                  <line
                    className="journey__lane"
                    x1={LEFT}
                    x2={WIDTH - RIGHT}
                    y1={ROW / 2}
                    y2={ROW / 2}
                  />
                  <g style={{ fill: agent.style.color }}>
                    {row.events.map((event, i) => (
                      <g key={`${event.at}-${i}`} className="journey__mark" data-kind={event.kind}>
                        <title>{`${agent.name}: ${event.label}, ${when(event.at)}`}</title>
                        <MarkShape kind={event.kind} x={x(Date.parse(event.at))} y={ROW / 2} />
                      </g>
                    ))}
                  </g>
                </svg>
              </div>
            )
          })}
          <div className="journey__row journey__row--axis">
            <span />
            <svg className="journey__svg" viewBox={`0 0 ${WIDTH} ${AXIS}`} aria-hidden="true">
              {ticks.map((tick, index) =>
                tick >= end ? null : (
                  <text
                    key={tick}
                    className="journey__tick"
                    x={x(tick)}
                    y={19}
                    textAnchor={index === 0 ? 'start' : 'middle'}
                  >
                    {shortDate(tick)}
                  </text>
                ),
              )}
            </svg>
          </div>
        </div>
      </div>
      <div
        className="journey__table-scroll"
        role="region"
        aria-label="Journey counts, scroll to see all columns"
        tabIndex={0}
      >
        <table className="reports-table journey__table" aria-label="Journey counts per agent">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              {KINDS.map(({ kind, plural }) => (
                <th key={kind} scope="col">
                  {plural[0]!.toUpperCase() + plural.slice(1)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {journey.agents.map((row) => (
              <tr key={row.id}>
                <th scope="row">
                  <span className="reports-table__agent">
                    <span className="reports-glyph reports-glyph--26">
                      <AgentGlyph agent={agentFor(agents, row.id)} size="sm" decorative />
                    </span>
                    {agentFor(agents, row.id).name}
                  </span>
                </th>
                {counts(row.events).map((count, i) => (
                  <td key={KINDS[i]!.kind}>{count}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="journey__list">
        <summary>All marks as a list</summary>
        {journey.agents.map((row) => (
          <section key={row.id} aria-label={`${agentFor(agents, row.id).name}, marks`}>
            <h3>{agentFor(agents, row.id).name}</h3>
            {row.events.length === 0 ? (
              <p className="reports-empty">Nothing in this range.</p>
            ) : (
              <ul>
                {row.events.map((event, i) => (
                  <li key={`${event.at}-${i}`}>
                    <time dateTime={event.at}>{when(event.at)}</time>:{' '}
                    {KINDS.find((item) => item.kind === event.kind)!.label}
                    {event.kind === 'memory_changed' ? '' : `, ${event.label}`}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </details>
    </div>
  )
}
