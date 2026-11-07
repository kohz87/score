import type { AgentSummary, Job } from '@score/contract'
import type { ReactNode } from 'react'
import { JobBar, NextUp, PastJobBar } from './JobBar.tsx'

export function RoomJobStrip({
  roomId,
  showNextUp,
  agents,
  barJob,
  stoppedNote,
  pastPicked,
  menu,
  moreOpen,
  onShowMore,
  onShowGraph,
  onStopped,
}: {
  roomId: string
  showNextUp: boolean
  agents: AgentSummary[]
  barJob: Job | null
  stoppedNote: { jobId: string; text: string } | null
  pastPicked: Job | null
  menu: (job: Job) => ReactNode
  moreOpen: number
  onShowMore: () => void
  onShowGraph: (jobId: string) => void
  onStopped: (job: Job) => void
}) {
  if (!barJob && !stoppedNote && !pastPicked && !showNextUp) return null

  return (
    <div className="bold-job-strip">
      {barJob && (
        <JobBar
          job={barJob}
          agents={agents}
          onShowGraph={onShowGraph}
          menu={menu(barJob)}
          moreOpen={moreOpen}
          onShowMore={onShowMore}
          onStopped={onStopped}
        />
      )}
      {!barJob && stoppedNote && (
        <p className="bold-thread-status-line bold-job-stopped" role="status">
          {stoppedNote.text}
        </p>
      )}
      {pastPicked && (
        <PastJobBar job={pastPicked} onShowGraph={onShowGraph} menu={menu(pastPicked)} />
      )}
      {showNextUp && <NextUp roomId={roomId} />}
    </div>
  )
}
