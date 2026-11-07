import { useState } from 'react'
import {
  customRangeError,
  viewerToday,
  type ReportSpec,
} from '../routes/reports/reports-queries.ts'

export function CustomRangeForm({
  spec,
  onApply,
}: {
  spec: ReportSpec
  onApply: (from: string, to: string) => void
}) {
  const today = viewerToday()
  // The parent keys this form by the range, so a preset picked while it is open re-seeds the inputs.
  const seedFrom = spec.range === 'custom' ? spec.from : today
  const seedTo = spec.range === 'custom' ? spec.to : today
  const [from, setFrom] = useState(seedFrom)
  const [to, setTo] = useState(seedTo)
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
