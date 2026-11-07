import type { Job } from '@score/contract'

export function RoomJobLifecycleNotice({
  notice,
  busyJobId,
  onStop,
  onDismiss,
}: {
  notice: { job: Job; text: string; stillWorking: boolean } | null
  busyJobId: string | null
  onStop: (job: Job) => void
  onDismiss: () => void
}) {
  if (!notice) return null

  return (
    <div
      className="bold-job-lifecycle-notice"
      data-protected="block"
      role={notice.stillWorking ? 'alert' : 'status'}
    >
      <span>{notice.text}</span>
      {notice.stillWorking && (
        <button
          type="button"
          className="btn sm"
          disabled={busyJobId === notice.job.id}
          onClick={() => onStop(notice.job)}
        >
          {busyJobId === notice.job.id ? 'Stopping…' : 'Stop'}
        </button>
      )}
      <button type="button" className="link" aria-label="Dismiss job notice" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  )
}
