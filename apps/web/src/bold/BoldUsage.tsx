import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useStreamQuery } from '../data/query-client.ts'
import { agentsQuery } from '../routes/chat/queries.ts'
import { formatDuration, formatPercent } from '../routes/reports/reports-format.ts'
import { JourneyChart } from '../routes/reports/JourneyChart.tsx'
import {
  customRangeError,
  reportCsvHref,
  reportRanges,
  useJourney,
  useReports,
  type ReportSpec,
} from '../routes/reports/reports-queries.ts'
import { ByAgentTable } from './BoldUsageAgentTable.tsx'
import { CustomRangeForm } from './BoldUsageCustomRangeForm.tsx'
import { Headline } from './BoldUsageHeadline.tsx'
import { SpendFigure } from './BoldUsageSpendFigure.tsx'
import { SpeedByAgent } from './BoldUsageSpeedTable.tsx'
import { TaskFigure } from './BoldUsageTaskFigure.tsx'
import { customLabel, rangeFrom, type Range } from './bold-usage-model.ts'
import { useMoney } from './use-bold-usage-money.ts'

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

      {customOpen && (
        <CustomRangeForm
          key={spec.range === 'custom' ? `${spec.from}/${spec.to}` : spec.range}
          spec={spec}
          onApply={setCustom}
        />
      )}

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
        <>
          <p role="status" className="usage-loading">
            Loading…
          </p>
          <ByAgentTable report={undefined} agents={agents} money={money} />
        </>
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

          <SpeedByAgent report={report} agents={agents} />

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
