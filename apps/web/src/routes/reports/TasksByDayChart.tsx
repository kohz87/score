import type { AgentSummary, Shape } from '@score/contract'
import { useId } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import './tasks-by-day-chart.css'

export type TasksByDayChartProps = {
  byDay: { date: string; perAgent: Record<string, number> }[]
  agents: AgentSummary[]
}

const WIDTH = 700
const PLOT_TOP = 28
const PLOT_HEIGHT = 208
const LABEL_HEIGHT = 28
const HEIGHT = PLOT_TOP + PLOT_HEIGHT + LABEL_HEIGHT
const SEGMENT_GAP = 3
// Agents Score no longer knows (e.g. a removed profile): grey plus their own pattern.
const UNKNOWN_COLOR = 'var(--agent-unknown)'
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// One distinct overlay per agent shape, so colour + pattern identify an agent.
type PatternKind =
  'dots' | 'diagonal' | 'vertical' | 'horizontal' | 'cross' | 'checks' | 'back-diagonal' | 'rings'

const patternByShape: Record<Shape, PatternKind> = {
  'circle-dot': 'rings',
  triangle: 'diagonal',
  diamond: 'cross',
  square: 'checks',
  hexagon: 'horizontal',
  star: 'dots',
  pill: 'vertical',
  cross: 'back-diagonal',
}
const unknownPattern: PatternKind = 'horizontal'

function PatternBody({ kind }: { kind: PatternKind }) {
  const line = { className: 'tasks-by-day__pattern-ink', strokeWidth: 2, opacity: 0.32 }
  switch (kind) {
    case 'dots':
      return <circle cx="4" cy="4" r="1.6" className="tasks-by-day__pattern-ink" opacity="0.4" />
    case 'rings':
      return (
        <circle
          cx="5"
          cy="5"
          r="2.2"
          fill="none"
          className="tasks-by-day__pattern-ink"
          opacity="0.4"
          strokeWidth="1.5"
        />
      )
    case 'diagonal':
      return <path d="M-1 9 L9 -1 M-1 1 L1 -1 M7 9 L9 7" {...line} />
    case 'back-diagonal':
      return <path d="M-1 -1 L9 9 M7 -1 L9 1 M-1 7 L1 9" {...line} />
    case 'vertical':
      return <path d="M4 0 V8" {...line} />
    case 'horizontal':
      return <path d="M0 4 H8" {...line} />
    case 'cross':
      return <path d="M4 0 V8 M0 4 H8" {...line} strokeWidth={1.5} />
    case 'checks':
      return (
        <>
          <rect width="4" height="4" className="tasks-by-day__pattern-ink" opacity="0.3" />
          <rect
            x="4"
            y="4"
            width="4"
            height="4"
            className="tasks-by-day__pattern-ink"
            opacity="0.3"
          />
        </>
      )
  }
}

// Past a month the per-bar totals would overlap; the accessible table still lists every day.
const MAX_TOTAL_LABELS = 31

function dayLabel(date: string, days: number, index: number): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return date
  if (days <= 7) return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? date
  // Sparse labels keep a 30-day axis readable.
  const step = Math.ceil(days / 7)
  if (index % step !== 0) return ''
  return `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

type Series = {
  id: string
  name: string
  color: string
  pattern: PatternKind
  agent?: AgentSummary
}

export function TasksByDayChart({ byDay, agents }: TasksByDayChartProps) {
  const uid = useId().replace(/:/g, '')
  const series: Series[] = agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    color: agent.style.color,
    pattern: patternByShape[agent.style.shape],
    agent,
  }))
  const known = new Set(agents.map((a) => a.id))
  const unknownIds: string[] = []
  for (const day of byDay) {
    for (const [id, n] of Object.entries(day.perAgent)) {
      if (!known.has(id) && n > 0 && !unknownIds.includes(id)) unknownIds.push(id)
    }
  }
  for (const id of unknownIds) {
    series.push({ id, name: id, color: UNKNOWN_COLOR, pattern: unknownPattern })
  }

  const count = (day: TasksByDayChartProps['byDay'][number], id: string) => {
    const n = day.perAgent[id] ?? 0
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  const totals = byDay.map((day) => series.reduce((sum, s) => sum + count(day, s.id), 0))
  const maxTotal = Math.max(1, ...totals)
  const unit = PLOT_HEIGHT / maxTotal
  const baseline = PLOT_TOP + PLOT_HEIGHT
  const slot = byDay.length > 0 ? WIDTH / byDay.length : WIDTH
  const barWidth = slot - Math.min(18, slot * 0.3)
  const grandTotal = totals.reduce((a, b) => a + b, 0)
  const summary = `Tasks finished per day: ${grandTotal} in total over ${byDay.length} ${
    byDay.length === 1 ? 'day' : 'days'
  }.`
  const patternId = (kind: PatternKind) => `${uid}-${kind}`
  const usedPatterns = [...new Set(series.map((s) => s.pattern))]
  const gridLevels = maxTotal > 1 ? [0.5, 1] : [1]

  return (
    <div className="tasks-by-day">
      <ul className="tasks-by-day__legend" aria-label="Agents">
        {series.map((s) => (
          <li key={s.id}>
            {s.agent ? (
              <AgentGlyph agent={s.agent} size="xs" bare decorative />
            ) : (
              <span className="tasks-by-day__swatch" aria-hidden="true" />
            )}
            <span>{s.name}</span>
          </li>
        ))}
      </ul>
      <div
        className="tasks-by-day__scroll"
        role="region"
        aria-label="Tasks by day chart, scroll to see all days"
        tabIndex={0}
      >
        <svg
          className="tasks-by-day__svg"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={summary}
          data-testid="tasks-by-day-svg"
        >
          <defs>
            {usedPatterns.map((kind) => (
              <pattern
                key={kind}
                id={patternId(kind)}
                width="8"
                height="8"
                patternUnits="userSpaceOnUse"
              >
                <PatternBody kind={kind} />
              </pattern>
            ))}
          </defs>
          {gridLevels.map((level) => (
            <line
              key={level}
              className="tasks-by-day__grid"
              x1={0}
              x2={WIDTH}
              y1={baseline - PLOT_HEIGHT * level}
              y2={baseline - PLOT_HEIGHT * level}
              strokeDasharray={level === 1 ? '4 4' : undefined}
            />
          ))}
          <line className="tasks-by-day__grid" x1={0} x2={WIDTH} y1={baseline} y2={baseline} />
          {byDay.map((day, index) => {
            const x = index * slot + (slot - barWidth) / 2
            let y = baseline
            return (
              <g key={`${day.date}-${index}`} data-day={day.date}>
                {series.map((s) => {
                  const n = count(day, s.id)
                  if (n === 0) return null
                  const height = Math.max(2, n * unit - SEGMENT_GAP)
                  y -= n * unit
                  const top = y + SEGMENT_GAP
                  const rx = Math.min(8, barWidth / 2, height / 2)
                  return (
                    <g key={s.id} data-agent={s.id} data-count={n}>
                      <rect
                        data-part="fill"
                        x={x}
                        y={top}
                        width={barWidth}
                        height={height}
                        rx={rx}
                        fill={s.color}
                      />
                      <rect
                        data-part="pattern"
                        data-pattern={s.pattern}
                        x={x}
                        y={top}
                        width={barWidth}
                        height={height}
                        rx={rx}
                        fill={`url(#${patternId(s.pattern)})`}
                      />
                    </g>
                  )
                })}
                {byDay.length <= MAX_TOTAL_LABELS && (
                  <text
                    className="tasks-by-day__total"
                    x={x + barWidth / 2}
                    y={baseline - totals[index]! * unit - 8}
                  >
                    {totals[index]}
                  </text>
                )}
                <text className="tasks-by-day__label" x={x + barWidth / 2} y={baseline + 20}>
                  {dayLabel(day.date, byDay.length, index)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      <table className="tasks-by-day__sr-only">
        <caption>Tasks finished per day, by agent</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {series.map((s) => (
              <th key={s.id} scope="col">
                {s.name}
              </th>
            ))}
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {byDay.map((day, index) => (
            <tr key={`${day.date}-${index}`}>
              <th scope="row">{day.date}</th>
              {series.map((s) => (
                <td key={s.id}>{count(day, s.id)}</td>
              ))}
              <td>{totals[index]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
