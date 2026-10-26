import type { AgentSummary, Reports } from '@score/contract'
import { useId, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { useStreamQuery } from '../data/query-client.ts'
import { agentsQuery } from '../routes/chat/queries.ts'
import { formatMoney, useDisplayCurrency, USD } from '../data/currency.ts'
import { formatDuration, formatPercent } from '../routes/reports/reports-format.ts'
import { JourneyChart } from '../routes/reports/JourneyChart.tsx'
import {
  customRangeError,
  reportCsvHref,
  reportRanges,
  useJourney,
  useReports,
  viewerToday,
  type ReportSpec,
} from '../routes/reports/reports-queries.ts'

type Range = Exclude<Reports['range'], 'custom'>
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

/**
 * Money as the classic Reports page shows it: USD, or the currency from Settings › Look when the person picked it there
 * (remembered per browser), so both shells show the same numbers.
 */
function useMoney(): (usd: number | null) => string {
  const configured = useDisplayCurrency().data ?? USD
  let other = false
  try {
    other = localStorage.getItem('score.reports.currency') === 'other'
  } catch {
    // Blocked storage: USD.
  }
  const shown = configured.code !== 'USD' && other ? configured : USD
  return (usd) => formatMoney(usd, shown)
}

export function chartTone(agent: AgentSummary): string {
  return CHART_TONES[agent.style.color.toUpperCase()] ?? agent.style.color
}

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

function rangeFrom(params: URLSearchParams): Range {
  const value = params.get('range')
  return value && rangeIds.has(value as Range) ? (value as Range) : DEFAULT_RANGE
}

function shortDay(day: string, withYear: boolean): string {
  const [y, m, d] = day.split('-').map(Number)
  return `${d} ${MONTHS[(m ?? 1) - 1]}${withYear ? ` ${y}` : ''}`
}

/** "3 Oct – 9 Oct", with the year when the range is not in the current one. */
function customLabel(from: string, to: string): string {
  const year = viewerToday().slice(0, 4)
  const withYear = from.slice(0, 4) !== year || to.slice(0, 4) !== year
  return `${shortDay(from, withYear)} – ${shortDay(to, withYear)}`
}

function CustomRangeForm({
  spec,
  onApply,
}: {
  spec: ReportSpec
  onApply: (from: string, to: string) => void
}) {
  const today = viewerToday()
  const [from, setFrom] = useState(spec.range === 'custom' ? spec.from : today)
  const [to, setTo] = useState(spec.range === 'custom' ? spec.to : today)
  const problem = customRangeError(from, to, today)
  return (
    <form
      id="usage-custom-form"
      className="usage-custom"
      aria-label="Custom range"
      onSubmit={(event) => {
        event.preventDefault()
        if (!problem) onApply(from, to)
      }}
    >
      <label>
        From
        <input
          type="date"
          value={from}
          max={to && to < today ? to : today}
          onChange={(event) => setFrom(event.target.value)}
        />
      </label>
      <label>
        To
        <input
          type="date"
          value={to}
          min={from || undefined}
          max={today}
          onChange={(event) => setTo(event.target.value)}
        />
      </label>
      <button type="submit" className="btn sm primary" disabled={problem !== null}>
        Apply
      </button>
      {problem && (
        <p className="usage-custom-problem small muted" role="status">
          {problem}
        </p>
      )}
    </form>
  )
}

const pct = (value: number | null) => (value === null ? '—' : formatPercent(value))

function ByAgentTable({
  report,
  agents,
  money,
}: {
  report: Reports
  agents: AgentSummary[]
  money: (usd: number | null) => string
}) {
  const spendText = (row: Reports['byAgent'][number]) =>
    row.spendBasis === 'unknown'
      ? 'unknown'
      : row.spendBasis === 'estimated'
        ? `${money(row.spendUsd)} estimated`
        : money(row.spendUsd)
  return (
    <section className="card usage-figure usage-by-agent" aria-labelledby="usage-by-agent-title">
      <h3 id="usage-by-agent-title">By agent</h3>
      {report.byAgent.length === 0 ? (
        <p className="usage-empty">No agents yet.</p>
      ) : (
        <div
          className="usage-table-scroll"
          role="region"
          aria-label="By agent table, scroll to see all columns"
          tabIndex={0}
        >
          <table className="usage-table usage-agent-table" aria-labelledby="usage-by-agent-title">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Jobs done</th>
                <th scope="col">Runs</th>
                <th scope="col">Median time</th>
                <th scope="col">First-time pass</th>
                <th scope="col">Cache hits</th>
                <th scope="col">Spend</th>
              </tr>
            </thead>
            <tbody>
              {report.byAgent.map((row) => {
                const agent = agentFor(agents, row.agentId)
                return (
                  <tr key={row.agentId}>
                    <th scope="row">
                      <span className="usage-agent-cell">
                        <AgentGlyph agent={agent} size="xs" bare decorative />
                        {agent.name}
                      </span>
                    </th>
                    <td>{row.finished}</td>
                    <td>{row.runs}</td>
                    <td>{formatDuration(row.medianSec)}</td>
                    <td>{pct(row.firstPassRate)}</td>
                    <td>{pct(row.cacheHitRate)}</td>
                    <td>{spendText(row)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function dayLabel(date: string, days: number, index: number): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return date
  if (days <= 7) return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? date
  // A month of daily bars cannot fit 30 labels at phone width; label every fifth day like the classic chart.
  const step = Math.ceil(days / 7)
  return index % step === 0 ? `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : ''
}

function dayTitle(date: string): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return date
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? date} ${date}`
}

function Headline({
  label,
  value,
  detail,
  stat,
}: {
  label: string
  value: string
  detail: string
  stat: string
}) {
  return (
    <div className="card usage-stat" data-stat={stat}>
      <span className="small muted">{label}</span>
      <b>{value}</b>
      <span className="small muted">{detail}</span>
    </div>
  )
}

function TaskFigure({ report, agents }: { report: Reports; agents: AgentSummary[] }) {
  const [showTable, setShowTable] = useState(false)
  const uid = useId().replace(/:/g, '')
  const tableId = `usage-tasks-table-${uid}`
  const count = (day: Reports['byDay'][number], id: string) => {
    const n = day.perAgent[id] ?? 0
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  const totals = report.byDay.map((day) =>
    Object.keys(day.perAgent).reduce((sum, id) => sum + count(day, id), 0),
  )
  const max = Math.max(0, ...totals)
  const agentIds = new Set<string>()
  for (const day of report.byDay)
    for (const [id, n] of Object.entries(day.perAgent)) if (n > 0) agentIds.add(id)
  const known = agents.filter((agent) => agentIds.has(agent.id))
  const unknown = [...agentIds]
    .filter((id) => !agents.some((agent) => agent.id === id))
    .map((id) => agentFor(agents, id))
  const series = [...known, ...unknown]
  const summary = report.byDay
    .map((day, index) => `${dayTitle(day.date)}: ${totals[index]}`)
    .join(', ')

  return (
    <section className="card usage-figure" aria-labelledby={`usage-tasks-title-${uid}`}>
      <header className="row wrap usage-figure-head">
        <h3 id={`usage-tasks-title-${uid}`}>Jobs done per day</h3>
        {report.totals.tasksFinished > 0 && (
          <button
            type="button"
            className="link"
            aria-expanded={showTable}
            aria-controls={tableId}
            onClick={() => setShowTable((shown) => !shown)}
          >
            {showTable ? 'Hide table' : 'Show as table'}
          </button>
        )}
      </header>
      {report.totals.tasksFinished === 0 ? (
        <p className="usage-empty">No jobs finished in this range.</p>
      ) : (
        <div className="usage-jobs-chart">
          <div className="usage-jobs-bars" role="img" aria-label={`Jobs done: ${summary}.`}>
            {report.byDay.map((day, index) => {
              const total = totals[index] ?? 0
              const busiest = max > 0 && total === max
              const height = max > 0 ? Math.max((total / max) * 150, total ? 4 : 0) : 0
              return (
                <span
                  key={`${day.date}-${index}`}
                  className="usage-jobs-column"
                  data-day={day.date}
                  data-total={total}
                  title={`${dayTitle(day.date)}: ${total}`}
                >
                  {busiest && <span className="usage-jobs-value">{total}</span>}
                  <span
                    className={`usage-jobs-bar${busiest ? ' usage-jobs-bar--busiest' : ''}`}
                    data-part="bar"
                    style={{ height: `${height}px` }}
                  />
                </span>
              )
            })}
          </div>
          <div className="usage-jobs-labels" aria-hidden="true">
            {report.byDay.map((day, index) => (
              <span key={`${day.date}-${index}`} className="usage-jobs-label">
                {dayLabel(day.date, report.byDay.length, index)}
              </span>
            ))}
          </div>
        </div>
      )}
      {report.totals.tasksFinished > 0 && (
        <table
          id={tableId}
          className={showTable ? 'usage-table' : 'usage-sr-only'}
          aria-label="Jobs done per day, by agent"
        >
          <caption>Jobs done per day, by agent</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Jobs done</th>
              {series.map((agent) => (
                <th key={agent.id} scope="col">
                  {agent.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.byDay.map((day, index) => (
              <tr key={`${day.date}-${index}`}>
                <th scope="row">{day.date}</th>
                <td>{totals[index]}</td>
                {series.map((agent) => (
                  <td key={agent.id}>{count(day, agent.id)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function SpendFigure({
  report,
  agents,
  money,
}: {
  report: Reports
  agents: AgentSummary[]
  money: (usd: number | null) => string
}) {
  const [showTable, setShowTable] = useState(false)
  const uid = useId().replace(/:/g, '')
  const tableId = `usage-spend-table-${uid}`
  const max = Math.max(0, ...report.byAgent.map((row) => row.spendUsd ?? 0))
  // A coding agent's figure can be an estimate (subscription work at API prices) or unknown: say so beside the number.
  const spendText = (row: { spendUsd: number | null; spendBasis?: string }) =>
    row.spendBasis === 'unknown'
      ? 'unknown'
      : row.spendBasis === 'estimated'
        ? `${money(row.spendUsd)} estimated`
        : money(row.spendUsd)
  const rows = report.byAgent
    .map((row) => ({
      ...row,
      agent: agentFor(agents, row.agentId),
    }))
    .sort((a, b) => {
      if (a.spendUsd === null) return b.spendUsd === null ? 0 : 1
      if (b.spendUsd === null) return -1
      return b.spendUsd - a.spendUsd || a.agent.name.localeCompare(b.agent.name)
    })

  return (
    <section className="card usage-figure" aria-labelledby={`usage-spend-title-${uid}`}>
      <header className="row wrap usage-figure-head">
        <h3 id={`usage-spend-title-${uid}`}>Spend by agent</h3>
        {rows.length > 0 && (
          <button
            type="button"
            className="link"
            aria-expanded={showTable}
            aria-controls={tableId}
            onClick={() => setShowTable((shown) => !shown)}
          >
            {showTable ? 'Hide table' : 'Show as table'}
          </button>
        )}
      </header>
      {rows.length === 0 ? (
        <p className="usage-empty">No agents yet.</p>
      ) : (
        <div
          className="usage-spend"
          role="img"
          aria-label={`Spend by agent: ${rows
            .map((row) => `${row.agent.name} ${spendText(row)}`)
            .join(', ')}.`}
        >
          {rows.map((row) => {
            const color = chartTone(row.agent)
            const width = row.spendUsd === null || max === 0 ? 0 : (row.spendUsd / max) * 80
            return (
              <div className="usage-spend-row" key={row.agentId}>
                <span className="usage-spend-name">
                  <AgentGlyph
                    agent={{ ...row.agent, style: { ...row.agent.style, color } }}
                    size="xs"
                    bare
                    decorative
                  />
                  {row.agent.name}
                </span>
                <span className="usage-spend-bar-wrap">
                  <span
                    className="usage-spend-bar"
                    title={`${row.agent.name}: ${spendText(row)}`}
                    style={{ width: `${width}%`, background: color }}
                  />
                  <span className="usage-spend-value">{spendText(row)}</span>
                </span>
              </div>
            )
          })}
        </div>
      )}
      <p className="small muted usage-note">
        Free models count as $0, where providers report it.
        {report.totals.spendEstimated
          ? ' An estimated amount is what subscription work would cost at API prices.'
          : ''}
        {report.totals.spendExcluded?.length
          ? ` ${report.totals.spendExcluded.length === 1 ? 'One coding agent gave' : 'Some coding agents gave'} no cost and ${report.totals.spendExcluded.length === 1 ? 'is' : 'are'} left out.`
          : ''}
      </p>
      <table
        id={tableId}
        className={showTable ? 'usage-table' : 'usage-sr-only'}
        aria-label="Spend by agent"
      >
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Spend</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.agentId}>
              <th scope="row">{row.agent.name}</th>
              <td>{spendText(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

export function BoldUsage() {
  const money = useMoney()
  const [params, setParams] = useSearchParams()
  const custom = params.get('range') === 'custom'
  const urlFrom = params.get('from') ?? ''
  const urlTo = params.get('to') ?? ''
  const range = rangeFrom(params)
  const spec = useMemo<ReportSpec>(() => {
    // A shared link with a bad custom range falls back to the default instead of erroring.
    if (custom && customRangeError(urlFrom, urlTo) === null)
      return { range: 'custom', from: urlFrom, to: urlTo }
    return { range }
  }, [custom, urlFrom, urlTo, range])
  const [customOpen, setCustomOpen] = useState(custom)
  const reports = useReports(spec)
  const journeyOn = params.get('tab') === 'journey'
  const journey = useJourney(spec, journeyOn)
  const agents = useStreamQuery(agentsQuery).data ?? []
  const report = reports.data
  const stale = reports.isPlaceholderData

  function setTab(tab: 'overview' | 'journey') {
    setParams(
      (current) => {
        const copy = new URLSearchParams(current)
        if (tab === 'journey') copy.set('tab', 'journey')
        else copy.delete('tab')
        return copy
      },
      { replace: true },
    )
  }

  function setRange(next: Range) {
    setParams(
      (current) => {
        const copy = new URLSearchParams(current)
        copy.set('range', next)
        copy.delete('from')
        copy.delete('to')
        return copy
      },
      { replace: true },
    )
  }

  function setCustom(from: string, to: string) {
    setParams(
      (current) => {
        const copy = new URLSearchParams(current)
        copy.set('range', 'custom')
        copy.set('from', from)
        copy.set('to', to)
        return copy
      },
      { replace: true },
    )
  }

  // Reports gives waiting-on-you as per-agent shares, not a total duration. Its approvals block exposes only the
  // median wait for a decision by you, so the headline names that figure rather than inventing a total.
  const waiting = formatDuration(report?.approvals.medianWaitSec ?? null)
  const answered = report ? report.approvals.approved + report.approvals.denied : 0

  return (
    <div className="usage">
      <div className="row wrap usage-head">
        <h2 className="grow">Usage</h2>
        <div className="seg" role="group" aria-label="View">
          <button
            type="button"
            className={journeyOn ? undefined : 'on'}
            aria-pressed={!journeyOn}
            onClick={() => setTab('overview')}
          >
            Overview
          </button>
          <button
            type="button"
            className={journeyOn ? 'on' : undefined}
            aria-pressed={journeyOn}
            onClick={() => setTab('journey')}
          >
            Journey
          </button>
        </div>
        <div className="seg" role="group" aria-label="Range">
          {reportRanges.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={spec.range === id ? 'on' : undefined}
              aria-pressed={spec.range === id}
              onClick={() => setRange(id)}
            >
              {label}
              {spec.range === id && reports.isFetching && (
                <span className="usage-spinner" aria-hidden="true" />
              )}
            </button>
          ))}
          <button
            type="button"
            className={spec.range === 'custom' ? 'on' : undefined}
            aria-pressed={spec.range === 'custom'}
            aria-expanded={customOpen}
            aria-controls="usage-custom-form"
            onClick={() => setCustomOpen((shown) => !shown)}
          >
            {spec.range === 'custom' ? customLabel(spec.from, spec.to) : 'Custom'}
            {spec.range === 'custom' && reports.isFetching && (
              <span className="usage-spinner" aria-hidden="true" />
            )}
          </button>
        </div>
        {!journeyOn && (
          <a className="btn sm" href={reportCsvHref(spec)} download>
            Download CSV
          </a>
        )}
      </div>

      {customOpen && <CustomRangeForm spec={spec} onApply={setCustom} />}

      {journeyOn && (
        <section
          className={`card usage-figure usage-journey${journey.isPlaceholderData ? ' usage-body--stale' : ''}`}
          aria-labelledby="usage-journey-title"
          aria-busy={journey.isFetching}
        >
          <h3 id="usage-journey-title">Journey: tasks, notes, skills and memory over time</h3>
          {journey.data ? (
            <JourneyChart journey={journey.data} agents={agents} />
          ) : journey.isError ? (
            <p role="alert" className="usage-error">
              Couldn’t load the journey.{' '}
              <button type="button" className="link" onClick={() => void journey.refetch()}>
                Try again
              </button>
            </p>
          ) : (
            <p role="status" className="usage-loading">
              Loading the journey…
            </p>
          )}
        </section>
      )}
      {reports.isError && !journeyOn && (
        <p role="alert" className="usage-error">
          Couldn’t load reports.{' '}
          <button type="button" className="link" onClick={() => void reports.refetch()}>
            Try again
          </button>
        </p>
      )}
      {!report && !reports.isError && !journeyOn && (
        <p role="status" className="usage-loading">
          Loading…
        </p>
      )}
      {report && !journeyOn && (
        <div
          className={`usage-body${stale ? ' usage-body--stale' : ''}`}
          aria-busy={reports.isFetching}
        >
          <section className="grid4 usage-stats" aria-label="Usage in numbers">
            <Headline
              stat="jobs-done"
              label="Jobs done"
              value={report.totals.tasksFinished.toString()}
              detail="finished in this range"
            />
            <Headline
              stat="first-pass"
              label="Approved first time"
              value={formatPercent(report.totals.firstPassRate)}
              detail="no send-back from reviewer"
            />
            <Headline
              stat="waiting-on-you"
              label="Needs you"
              value={waiting}
              detail={`${answered} ${answered === 1 ? 'approval' : 'approvals'} answered · median wait`}
            />
            <Headline
              stat="spend"
              label="Spend"
              value={money(report.totals.spendUsd)}
              detail="where providers report it"
            />
          </section>

          <p className="usage-note small muted">
            Approvals you answered: {answered} in this range.{' '}
            <Link className="link" to="/b/settings/rules">
              Review rules
            </Link>
          </p>

          <div className="grid2 usage-charts">
            <TaskFigure report={report} agents={agents} />
            <SpendFigure report={report} agents={agents} money={money} />
          </div>

          <ByAgentTable report={report} agents={agents} money={money} />

          {report.unattributed && (
            <p className="usage-note small muted">
              Unknown agent: {report.unattributed.runs} runs with no known agent,
              {report.unattributed.workingSec === 0
                ? ' no confirmed working time.'
                : ` ${formatDuration(report.unattributed.workingSec)} of confirmed working time.`}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
