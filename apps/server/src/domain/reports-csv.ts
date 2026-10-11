import type { Reports } from '@score/contract'

export const reportCsvColumns = [
  'Agent',
  'Finished',
  'Runs',
  'Median time (min)',
  'First-time pass (%)',
  'Spend (USD)',
] as const

const FORMULA_START = /^[=+\-@\t\r]/

/** One RFC 4180 field. Cells a spreadsheet would read as a formula get a leading single quote. */
export function csvCell(value: string | number | null): string {
  let text = value === null ? '' : String(value)
  if (FORMULA_START.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** The same rows as the By agent table on the Reports page. Unknown values are empty; n/a (reviews) is "n/a". */
export function reportsToCsv(report: Reports, names: Record<string, string>): string {
  const rows = report.byAgent.map((row) => [
    names[row.agentId] ?? row.agentId,
    row.finished,
    row.runs,
    row.medianSec === null ? null : Math.round(row.medianSec / 6) / 10,
    row.firstPassRate === null ? 'n/a' : Math.round(row.firstPassRate * 100),
    row.spendUsd === null ? null : row.spendUsd.toFixed(2),
  ])
  // Kanban attempts without a known agent (5.17a-1): counted, never assigned to anybody.
  if (report.unattributed)
    rows.push(['Unknown agent', null, report.unattributed.runs, null, null, null])
  return (
    [reportCsvColumns, ...rows]
      .map((row) => row.map((cell) => csvCell(cell)).join(','))
      .join('\r\n') + '\r\n'
  )
}
