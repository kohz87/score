import { UnattributedGlyph } from '../../components/UnattributedGlyph.tsx'
import type { AgentSummary, Reports } from '@score/contract'
import { ReportRangeSchema } from '@score/contract'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { useStreamQuery } from '../../data/query-client.ts'
import { agentsQuery } from '../team/team-queries.ts'
import { TasksByDayChart } from './TasksByDayChart.tsx'
import { formatDuration, formatPercent } from './reports-format.ts'
import { formatMoney, useDisplayCurrency, USD } from '../../data/currency.ts'
import { TrendChart } from './TrendChart.tsx'
import {
  customRangeError,
  reportCsvHref,
  reportRanges,
  useReports,
  viewerToday,
  type ReportSpec,
} from './reports-queries.ts'
import './reports.css'

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

type Money = (usd: number | null) => string

function Totals({ totals, money }: { totals: Reports['totals']; money: Money }) {
  const items: [string, string][] = [
    [totals.tasksFinished.toString(), 'tasks finished'],
    [totals.runs.toString(), 'agent runs'],
    [formatPercent(totals.firstPassRate), 'passed review first time'],
    [formatDuration(totals.medianTaskSec), 'median time per task'],
    [money(totals.spendUsd), 'model spend'],
    [formatPercent(totals.cacheHitRate), 'prompt cache hit rate'],
  ]
  return (
    <section className="reports-card reports-totals" aria-label="In numbers">
      {items.map(([value, label]) => (
        <div key={label} className="reports-stat">
          <span className="reports-stat__value">{value}</span>
          <span className="reports-stat__label">{label}</span>
        </div>
      ))}
    </section>
  )
}

function TimeSplit({ report, agents }: { report: Reports; agents: AgentSummary[] }) {
  return (
    <section className="reports-card reports-split" aria-labelledby="reports-split-title">
      <h2 id="reports-split-title">Where each agent&apos;s time goes</h2>
      {report.timeSplit.length === 0 && <p className="reports-empty">No agents yet.</p>}
      {report.timeSplit.map((row) => {
        const agent = agentFor(agents, row.agentId)
        return (
          <div key={row.agentId} className="reports-split__row">
            <div className="reports-split__head">
              <span className="reports-glyph reports-glyph--22">
                <AgentGlyph agent={agent} size="sm" decorative />
              </span>
              <span className="reports-split__name">{agent.name}</span>
              <span className="reports-split__working">{row.workingPct}% working</span>
            </div>
            <div
              className="reports-bar"
              role="img"
              aria-label={`${agent.name}: ${row.workingPct}% working, ${row.waitingOnYouPct}% waiting on you, ${row.waitingOnAgentPct}% waiting on another agent`}
            >
              <span
                className="reports-bar__working"
                style={{ width: `${row.workingPct}%`, background: agent.style.color }}
              />
              <span className="reports-bar__you" style={{ width: `${row.waitingOnYouPct}%` }} />
              <span className="reports-bar__agent" style={{ width: `${row.waitingOnAgentPct}%` }} />
            </div>
          </div>
        )
      })}
      <ul className="reports-legend" aria-label="Legend">
        <li>
          <span className="reports-swatch reports-swatch--working" />
          Working
        </li>
        <li>
          <span className="reports-swatch reports-swatch--you" />
          Waiting on you
        </li>
        <li>
          <span className="reports-swatch reports-swatch--agent" />
          Waiting on another agent
        </li>
      </ul>
    </section>
  )
}

function ByAgent({
  report,
  agents,
  money,
}: {
  report: Reports
  agents: AgentSummary[]
  money: Money
}) {
  return (
    <section className="reports-card reports-table-card" aria-labelledby="reports-agents-title">
      <h2 id="reports-agents-title">By agent</h2>
      <div
        className="reports-table-scroll"
        role="region"
        aria-label="By agent table, scroll to see all columns"
        tabIndex={0}
      >
        <table className="reports-table" aria-labelledby="reports-agents-title">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Finished</th>
              <th scope="col">Runs</th>
              <th scope="col">Median time</th>
              <th scope="col">First-time pass</th>
              <th scope="col">Cache hits</th>
              <th scope="col" className="reports-table__right">
                Spend
              </th>
            </tr>
          </thead>
          <tbody>
            {report.byAgent.map((row) => {
              const agent = agentFor(agents, row.agentId)
              return (
                <tr key={row.agentId}>
                  <th scope="row">
                    <span className="reports-table__agent">
                      <span className="reports-glyph reports-glyph--26">
                        <AgentGlyph agent={agent} size="sm" decorative />
                      </span>
                      {agent.name}
                    </span>
                  </th>
                  <td>{row.finished}</td>
                  <td>{row.runs}</td>
                  <td>{formatDuration(row.medianSec)}</td>
                  <td>
                    {row.firstPassRate !== null ? (
                      formatPercent(row.firstPassRate)
                    ) : /review/i.test(agent.role) ? (
                      'n/a, reviews'
                    ) : (
                      <span aria-label="No reviewed tasks in this range">—</span>
                    )}
                  </td>
                  <td>
                    {row.cacheHitRate === null ? (
                      <span aria-label="Hermes gave no cache figures">—</span>
                    ) : (
                      formatPercent(row.cacheHitRate)
                    )}
                  </td>
                  <td className="reports-table__right reports-table__spend">
                    {money(row.spendUsd)}
                  </td>
                </tr>
              )
            })}
            {report.unattributed && (
              <tr>
                <th scope="row">
                  <span className="reports-table__agent">
                    <span className="reports-glyph reports-glyph--26">
                      <UnattributedGlyph size="sm" decorative />
                    </span>
                    Unattributed
                  </span>
                </th>
                <td>—</td>
                <td>{report.unattributed.runs}</td>
                <td>—</td>
                <td>—</td>
                <td>—</td>
                <td className="reports-table__right reports-table__spend">—</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {report.unattributed && (
        <p className="reports-note">
          Unattributed: Kanban attempts with no known agent, so no spend or reviews are counted for
          them. Working time {formatDuration(report.unattributed.workingSec)} counts attempts with
          proven evidence only.
        </p>
      )}
    </section>
  )
}

function Approvals({ approvals }: { approvals: Reports['approvals'] }) {
  const { asked, approved, denied } = approvals
  const share = (n: number) => (asked > 0 ? (n / asked) * 100 : 0)
  return (
    <section className="reports-approvals" aria-labelledby="reports-approvals-title">
      <h2 id="reports-approvals-title">Your approvals</h2>
      <div className="reports-approvals__stats">
        <div className="reports-approvals__stat">
          <span className="reports-stat__value">{asked}</span>
          <span>asked</span>
        </div>
        <div className="reports-approvals__stat">
          <span className="reports-stat__value">{formatDuration(approvals.medianWaitSec)}</span>
          <span>median wait</span>
        </div>
      </div>
      <div className="reports-approvals__bar" aria-hidden="true">
        <span className="reports-approvals__approved" style={{ width: `${share(approved)}%` }} />
        <span className="reports-approvals__denied" style={{ width: `${share(denied)}%` }} />
      </div>
      <div className="reports-approvals__counts">
        <span>{approved} approved</span>
        <span>{denied} denied</span>
      </div>
      {approvals.insight && <p className="reports-approvals__insight">{approvals.insight}</p>}
      <Link to="/settings#rules">Review rules</Link>
    </section>
  )
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function shortDay(day: string, withYear: boolean): string {
  const [y, m, d] = day.split('-').map(Number)
  return `${d} ${MONTHS[m! - 1]}${withYear ? ` ${y}` : ''}`
}
/** "3 Oct – 9 Oct", with the year when the range is not in the current one. */
export function customLabel(from: string, to: string): string {
  const year = viewerToday().slice(0, 4)
  const withYear = from.slice(0, 4) !== year || to.slice(0, 4) !== year
  return `${shortDay(from, withYear)} – ${shortDay(to, withYear)}`
}

function CustomRange({
  spec,
  busy,
  onApply,
}: {
  spec: ReportSpec
  busy: boolean
  onApply: (from: string, to: string) => void
}) {
  const [open, setOpen] = useState(false)
  const today = viewerToday()
  const active = spec.range === 'custom'
  const [from, setFrom] = useState(active ? spec.from : today)
  const [to, setTo] = useState(active ? spec.to : today)
  const id = useId()
  const wrapper = useRef<HTMLSpanElement>(null)
  const problem = customRangeError(from, to, today)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onPointer = (event: PointerEvent) => {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open])

  function toggle() {
    if (!open && active) {
      setFrom(spec.from)
      setTo(spec.to)
    }
    setOpen(!open)
  }

  return (
    <span className="reports-custom" ref={wrapper}>
      <button
        type="button"
        aria-pressed={active}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? `${id}-popover` : undefined}
        onClick={toggle}
      >
        {active ? customLabel(spec.from, spec.to) : 'Custom'}
        {active && busy && <span className="reports-spinner" aria-hidden="true" />}
      </button>
      {open && (
        <form
          id={`${id}-popover`}
          className="reports-popover"
          role="dialog"
          aria-label="Custom range"
          onSubmit={(event) => {
            event.preventDefault()
            if (problem) return
            onApply(from, to)
            setOpen(false)
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
          {problem && (
            <p className="reports-popover__problem" role="status">
              {problem}
            </p>
          )}
          <button type="submit" className="reports-popover__apply" disabled={problem !== null}>
            Apply
          </button>
        </form>
      )}
    </span>
  )
}

export function ReportsPage() {
  const [params, setParams] = useSearchParams()
  const parsed = ReportRangeSchema.safeParse(params.get('range'))
  const urlRange = parsed.success ? parsed.data : '7d'
  const urlFrom = params.get('from') ?? ''
  const urlTo = params.get('to') ?? ''
  const spec = useMemo<ReportSpec>(() => {
    if (urlRange !== 'custom') return { range: urlRange }
    // A shared link with a bad custom range falls back to the default instead of erroring.
    return customRangeError(urlFrom, urlTo) === null
      ? { range: 'custom', from: urlFrom, to: urlTo }
      : { range: '7d' }
  }, [urlRange, urlFrom, urlTo])
  const reports = useReports(spec)
  const agents = useStreamQuery(agentsQuery).data ?? []
  const report = reports.data
  // Fetching with nothing newer to show; the numbers on screen may belong to the previous range.
  const stale = reports.isPlaceholderData
  // USD, or the currency set in Settings › Look when the person picks it here (remembered per browser).
  const configured = useDisplayCurrency().data ?? USD
  const [useOther, setUseOther] = useState(() => {
    try {
      return localStorage.getItem('score.reports.currency') === 'other'
    } catch {
      return false
    }
  })
  const showOther = configured.code !== 'USD' && useOther
  const shown = showOther ? configured : USD
  const money: Money = (usd) => formatMoney(usd, shown)
  function pickCurrency(other: boolean) {
    setUseOther(other)
    try {
      localStorage.setItem('score.reports.currency', other ? 'other' : 'usd')
    } catch {
      // A private window: the choice just isn't remembered.
    }
  }

  function setSpec(next: ReportSpec) {
    setParams((current) => {
      const copy = new URLSearchParams(current)
      copy.set('range', next.range)
      if (next.range === 'custom') {
        copy.set('from', next.from)
        copy.set('to', next.to)
      } else {
        copy.delete('from')
        copy.delete('to')
      }
      return copy
    })
  }

  return (
    <div className="reports">
      <section className="reports-hero">
        <div className="reports-hero__text">
          <h1>Reports</h1>
          <p className="reports-hero__summary" aria-live="polite">
            {report?.summary ?? (reports.isError ? 'Reports could not be loaded.' : 'Loading…')}
          </p>
        </div>
        <div className="reports-hero__actions">
          <div className="reports-tabs" role="group" aria-label="Range">
            {reportRanges.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={spec.range === id}
                onClick={() => setSpec({ range: id })}
              >
                {label}
                {spec.range === id && reports.isFetching && (
                  <span className="reports-spinner" aria-hidden="true" />
                )}
              </button>
            ))}
            <CustomRange
              spec={spec}
              busy={reports.isFetching}
              onApply={(from, to) => setSpec({ range: 'custom', from, to })}
            />
          </div>
          {configured.code !== 'USD' && (
            <div className="reports-tabs" role="group" aria-label="Currency">
              <button type="button" aria-pressed={!showOther} onClick={() => pickCurrency(false)}>
                USD
              </button>
              <button type="button" aria-pressed={showOther} onClick={() => pickCurrency(true)}>
                {configured.code}
              </button>
            </div>
          )}
          <a className="reports-export" href={reportCsvHref(spec)} download>
            Export CSV
          </a>
        </div>
      </section>
      {reports.isError && (
        <p role="alert" className="reports-error">
          Reports could not be loaded.{' '}
          <button type="button" onClick={() => void reports.refetch()}>
            Try again
          </button>
        </p>
      )}
      {report && (
        <div
          className={`reports-body${stale ? ' reports-body--stale' : ''}`}
          aria-busy={reports.isFetching}
        >
          <Totals totals={report.totals} money={money} />
          <div className="reports-row">
            <section className="reports-card reports-chart" aria-labelledby="reports-chart-title">
              <h2 id="reports-chart-title">Tasks finished, by day</h2>
              <TasksByDayChart byDay={report.byDay} agents={agents} />
            </section>
            <TimeSplit report={report} agents={agents} />
          </div>
          <div className="reports-row">
            <ByAgent report={report} agents={agents} money={money} />
            <Approvals approvals={report.approvals} />
          </div>
          <section className="reports-card reports-trend" aria-labelledby="reports-trend-title">
            <h2 id="reports-trend-title">Last 30 days: spend and runs</h2>
            <TrendChart trend={report.trend} money={money} />
          </section>
        </div>
      )}
    </div>
  )
}
