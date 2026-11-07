import type { AgentSummary, Reports } from '@score/contract'
import { reportRanges, viewerToday } from '../routes/reports/reports-queries.ts'

export type Range = Exclude<Reports['range'], 'custom'>
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const DEFAULT_RANGE: Range = '7d'
const rangeIds = new Set<Range>(reportRanges.map(({ id }) => id))
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** The validator-passing chart tones from docs/design/bold/README.md. Other agent colours stay as chosen. */
const CHART_TONES: Record<string, string> = {
  '#6B4EFF': '#7A61FF',
  '#19C39A': '#14A985',
  '#FFB61E': '#C08A10',
  '#FF6B8A': '#E85A7A',
}

export function chartTone(agent: AgentSummary): string {
  return CHART_TONES[agent.style.color.toUpperCase()] ?? agent.style.color
}

export function agentFor(agents: AgentSummary[], id: string): AgentSummary {
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

export function rangeFrom(params: URLSearchParams): Range {
  const value = params.get('range')
  return value && rangeIds.has(value as Range) ? (value as Range) : DEFAULT_RANGE
}

function shortDay(day: string, withYear: boolean): string {
  const [y, m, d] = day.split('-').map(Number)
  return `${d} ${MONTHS[(m ?? 1) - 1]}${withYear ? ` ${y}` : ''}`
}

/** "3 Oct – 9 Oct", with the year when the range is not in the current one. */
export function customLabel(from: string, to: string): string {
  const year = viewerToday().slice(0, 4)
  const withYear = from.slice(0, 4) !== year || to.slice(0, 4) !== year
  return `${shortDay(from, withYear)} – ${shortDay(to, withYear)}`
}

export function dayLabel(date: string, days: number, index: number): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return date
  if (days <= 7) return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? date
  // A month of daily bars cannot fit 30 labels at phone width; label every fifth day like the classic chart.
  const step = Math.ceil(days / 7)
  return index % step === 0 ? `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : ''
}

export function dayTitle(date: string): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return date
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? date} ${date}`
}
