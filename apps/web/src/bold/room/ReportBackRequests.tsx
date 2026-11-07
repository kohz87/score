import type { Job } from '@score/contract'
import { useMemo } from 'react'
import { useStreamQueryRefetch } from '../../data/query-client.ts'
import { PinCard } from './PinCards.tsx'
import { reportBackText } from './ReportBack.tsx'
import { useReportBack } from './report-back-store.ts'
import { roomJobsQuery } from './room-queries.ts'
import { reportBackWaiting } from './room-model.ts'

function ReportBackRequestCard({ job, refetch }: { job: Job; refetch: () => void }) {
  const reportBack = job.reportBack
  const state = reportBack?.state
  const text = reportBack ? reportBackText(reportBack, job.source) : null
  const report = useReportBack(job.id, state ?? null, refetch)
  if (!reportBack || !text || (state !== 'needs_ok' && state !== 'not_confirmed')) return null
  return (
    <PinCard
      pinKey={`report-back:${job.id}`}
      since={job.updatedAt}
      label={`Report back: ${job.title}`}
      anchor={{ job: job.id }}
    >
      <div className="bold-request-head">
        <b>{job.title}</b>
        <span className="bold-request-job">{job.source?.ref ?? 'Trigger'}</span>
      </div>
      <b className="bold-request-title">{text}</b>
      <span>Score can send the result back when you allow it.</span>
      <span className="row wrap">
        <button
          type="button"
          className="btn sm"
          disabled={report.sending}
          onClick={() => void report.send()}
        >
          {report.sending ? 'Sending…' : state === 'needs_ok' ? 'Send' : 'Try again'}
        </button>
      </span>
      {report.stillSending && (
        <span className="bold-report-back-note">Still sending — check the source</span>
      )}
      {report.error && (
        <span className="bold-request-error" role="alert">
          {report.error}
        </span>
      )}
    </PinCard>
  )
}

export function RoomReportBacks({ roomId, jobs }: { roomId: string; jobs: Job[] }) {
  const jobsDefinition = useMemo(() => roomJobsQuery(roomId), [roomId])
  const refetch = useStreamQueryRefetch(jobsDefinition)
  // A closed job asks nothing (reopen it to send its result back); the reads include closed jobs.
  const waiting = reportBackWaiting(jobs)
  return (
    <>
      {waiting.map((job) => (
        <ReportBackRequestCard key={job.id} job={job} refetch={refetch} />
      ))}
    </>
  )
}
