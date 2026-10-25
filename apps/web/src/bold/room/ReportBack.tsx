import type { Job, JobReportBack } from '@score/contract'
import { useMemo } from 'react'
import { useStreamQuery, useStreamQueryRefetch } from '../../data/query-client.ts'
import { useReportBack } from './report-back-store.ts'
import { roomJobsQuery } from './room-queries.ts'

function sentTime(at: string | null): string {
  if (!at) return ''
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function reportBackText(
  reportBack: JobReportBack,
  source: { app: string; ref: string } | null,
): string | null {
  const target = source?.ref ?? source?.app ?? 'the app'
  switch (reportBack.state) {
    case 'waiting':
      return `Will send the result back to ${target} when done`
    case 'needs_ok':
      return `Send the result back to ${target}?${reportBack.tool ? ` ${reportBack.tool}` : ''}`
    case 'sending':
      return 'Sending the result back…'
    case 'confirmed':
      return `Sent back ${sentTime(reportBack.at)}`.trim()
    case 'not_confirmed':
      return 'Couldn’t confirm the result was sent back'
    case 'off':
      return null
  }
}

export function ReportBackLine({ job, inThread = false }: { job: Job; inThread?: boolean }) {
  const reportBack = job.reportBack
  const jobsDefinition = useMemo(() => roomJobsQuery(job.roomId), [job.roomId])
  const refetchJobs = useStreamQueryRefetch(jobsDefinition)
  const live = useStreamQuery(jobsDefinition).data?.find((item) => item.id === job.id)
  const current = live?.reportBack ?? reportBack
  const currentText = current ? reportBackText(current, live?.source ?? job.source) : null
  const report = useReportBack(job.id, current?.state ?? null, refetchJobs)

  if (!current || !currentText) return null
  const state = current.state

  return (
    <span
      className={`bold-report-back${inThread ? ' bold-report-back--thread' : ''}`}
      data-protected="block"
      data-state={state}
      role="status"
    >
      <span className="bold-report-back-text">{currentText}</span>
      {(state === 'needs_ok' || state === 'not_confirmed') && (
        <button
          type="button"
          className="btn sm"
          disabled={report.sending}
          onClick={() => void report.send()}
        >
          {report.sending ? 'Sending…' : state === 'needs_ok' ? 'Send' : 'Try again'}
        </button>
      )}
      {report.stillSending && (
        <span className="bold-report-back-note">Still sending — check the source</span>
      )}
      {report.error && (
        <span className="bold-report-back-error" role="alert">
          {report.error}
        </span>
      )}
    </span>
  )
}
