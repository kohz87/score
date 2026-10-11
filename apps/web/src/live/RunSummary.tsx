import { summaryLine, type SummaryFacts } from './run-summary.ts'
import './live.css'

/** One line of facts when a run ends; nothing at all when Score knows none of them. */
export function RunSummary({
  facts,
  failed = false,
  label = 'Run summary',
}: {
  facts: SummaryFacts
  failed?: boolean
  label?: string
}) {
  const line = summaryLine(facts)
  if (line === null) return null
  return (
    <p
      className={`live-summary${failed ? ' live-summary--failed' : ''}`}
      aria-label={label}
      data-run-summary
    >
      {line}
    </p>
  )
}
