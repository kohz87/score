import type { Job, JobReportBack } from '@score/contract'
import { useEffect, useMemo, useState } from 'react'
import { apiFetch, ApiError } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { useStreamQuery, useStreamQueryRefetch } from '../../data/query-client.ts'
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
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const jobsDefinition = useMemo(() => roomJobsQuery(job.roomId), [job.roomId])
  const refetchJobs = useStreamQueryRefetch(jobsDefinition)
  const live = useStreamQuery(jobsDefinition).data?.find((item) => item.id === job.id)
  const current = live?.reportBack ?? reportBack
  const currentText = current ? reportBackText(current, live?.source ?? job.source) : null

  // The POST returns before the lead's turn finishes. The server derives confirmed/not_confirmed on read and does not
  // promise a stream event for the finish, so while `sending` the room's job read is checked again.
  useEffect(() => {
    if (current?.state !== 'sending') return
    const timer = setInterval(() => void refetchJobs(), 1500)
    return () => clearInterval(timer)
  }, [current?.state, refetchJobs])

  if (!current || !currentText) return null
  const state = current.state

  async function send() {
    if (!reportBack || sending) return
    setSending(true)
    setError(null)
    try {
      await apiFetch(`jobs/${encodeURIComponent(job.id)}/report-back`, {
        method: 'POST',
        headers: { 'Idempotency-Key': newId() },
        body: '{}',
      })
      await refetchJobs()
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 409
          ? failure.message
          : 'Couldn’t send the result back. Try again.',
      )
    } finally {
      setSending(false)
    }
  }

  return (
    <span
      className={`bold-report-back${inThread ? ' bold-report-back--thread' : ''}`}
      data-protected="block"
      data-state={state}
      role="status"
    >
      <span className="bold-report-back-text">{currentText}</span>
      {(state === 'needs_ok' || state === 'not_confirmed') && (
        <button type="button" className="btn sm" disabled={sending} onClick={() => void send()}>
          {sending ? 'Sending…' : state === 'needs_ok' ? 'Send' : 'Try again'}
        </button>
      )}
      {error && (
        <span className="bold-report-back-error" role="alert">
          {error}
        </span>
      )}
    </span>
  )
}
