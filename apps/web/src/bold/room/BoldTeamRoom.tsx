import type { AgentSummary, Room } from '@score/contract'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { useStreamQuery } from '../../data/query-client.ts'
import { useShowDeleted, setShowDeleted } from '../../routes/chat/deleted-toggle.ts'
import '../../routes/chat/chat.css'
import { Composer } from '../../routes/chat/Composer.tsx'
import { saveDraft } from '../../routes/chat/composer-model.ts'
import { ChevronIcon, PlusIcon } from '../BoldIcons.tsx'
import { RoomCapsules } from './RoomCapsules.tsx'
import { RoomEmpty } from './RoomEmpty.tsx'
import { RoomMessageStream } from './RoomMessageStream.tsx'
import { RoomRequests } from './RoomRequests.tsx'
import { RoomTabs } from './RoomTabs.tsx'
import { jobMatchesFilter, type JobFilter } from './room-model.ts'
import { roomJobsQuery, roomMessagesQuery, teamRoomQuery } from './room-queries.ts'
import { useStartJob } from '../BoldStartJob.tsx'
import './bold-room.css'

function RoomTitle({ name, action }: { name: string; action?: ReactNode }) {
  const startJob = useStartJob()
  return (
    <div className="roomhead">
      <button className="roomtitle" type="button">
        {name}
        <ChevronIcon />
      </button>
      {/* Start a job (11.10c) at the end of the room head. */}
      <button
        type="button"
        className="chip room-start"
        aria-label="Start a job"
        onClick={() => startJob?.openStartJob()}
      >
        <PlusIcon />
        Job
      </button>
      {action}
    </div>
  )
}

function RoomWaiting() {
  return (
    <p className="bold-stream-note" role="status">
      Loading the team room…
    </p>
  )
}

function RoomUnavailable({ error }: { error: boolean }) {
  return (
    <div className="bold-room-unavailable" role={error ? 'alert' : 'status'}>
      <b>{error ? 'Couldn’t open the team room.' : 'The team room isn’t ready yet.'}</b>
      <span>
        {error
          ? 'Check that Score is running, then try again.'
          : 'It appears once the team’s agents are known.'}
      </span>
    </div>
  )
}

function LoadedTeamRoom({
  room,
  agents,
  onOpenThread,
}: {
  room: Room
  agents: AgentSummary[]
  onOpenThread: (jobId: string) => void
}) {
  const [params, setParams] = useSearchParams()
  const jobsDefinition = useMemo(() => roomJobsQuery(room.id), [room.id])
  const { data: jobs, status: jobsStatus } = useStreamQuery(jobsDefinition)
  const allJobs = useMemo(() => jobs ?? [], [jobs])
  const defaultJobId = allJobs.find((job) => job.isDefault)?.id ?? null
  const [filter, setFilter] = useState<JobFilter>('all')
  const [composerKey, setComposerKey] = useState(0)
  const [openedJobs, setOpenedJobs] = useState<string[]>([])
  const showDeleted = useShowDeleted(room.id)
  const requestedJob = params.get('job') ?? 'all'
  // A tab that no longer exists, or that the D10 filter hides, falls back to All during render: an effect that called
  // selectJob would set state synchronously in an effect (and cascade a second render for the same event).
  const requested =
    requestedJob === 'all' ? undefined : allJobs.find((job) => job.id === requestedJob)
  const selectedJob =
    requestedJob === 'all'
      ? 'all'
      : jobsStatus !== 'success'
        ? requestedJob
        : requested && jobMatchesFilter(requested, filter)
          ? requestedJob
          : 'all'
  const seek = params.get('message')
  const command = params.get('command')

  // The message page the composer writes into: the selected job, or the room's default job from All. Its query key
  // does not depend on the room's job list, so a new job never refetches it or drops an optimistic message.
  const composerJobId = selectedJob === 'all' ? defaultJobId : selectedJob
  const baseMessagesDefinition = useMemo(
    () => roomMessagesQuery(room.id, composerJobId, null, defaultJobId),
    [composerJobId, defaultJobId, room.id],
  )
  const baseMessages = useStreamQuery(baseMessagesDefinition)

  const selectJob = useCallback(
    (jobId: string) => {
      const leaving = params.get('job')
      if (leaving)
        setOpenedJobs((current) => (current.includes(leaving) ? current : [...current, leaving]))
      const next = new URLSearchParams(params)
      if (jobId === 'all') next.delete('job')
      else next.set('job', jobId)
      next.delete('message')
      setParams(next, { replace: true })
    },
    [params, setParams],
  )

  const selectFilter = useCallback(
    (next: JobFilter) => {
      setFilter(next)
      // Leaving a tab it hides is a user action, so the URL is updated here rather than from an effect.
      if (requested && !jobMatchesFilter(requested, next)) selectJob('all')
    },
    [requested, selectJob],
  )

  // Opening a job is what reads it: the job on show counts as opened, and leaving it keeps it in the list (recorded in
  // selectJob), so All keeps showing its pages after a move and no other job's first page is read on mount (that would
  // clear every badge at once).
  const shownJob =
    selectedJob !== 'all' && allJobs.some((job) => job.id === selectedJob) ? selectedJob : null
  const opened = shownJob && !openedJobs.includes(shownJob) ? [...openedJobs, shownJob] : openedJobs

  const namedJobs = allJobs.filter((job) => !job.isDefault)
  const empty =
    jobsStatus === 'success' &&
    namedJobs.length === 0 &&
    baseMessages.status === 'success' &&
    (baseMessages.data?.items.length ?? 0) === 0
  const job = allJobs.find((item) => item.id === selectedJob)
  const lead = agents.find((agent) => agent.id === room.leadAgentId)
  const allLabel = lead ? `To: team room (${lead.name})` : 'No lead yet — use @name'
  const toLabel = job ? `To: ${job.title}` : allLabel

  const clearSeek = useCallback(() => {
    const next = new URLSearchParams(params)
    if (!next.has('message')) return
    next.delete('message')
    setParams(next, { replace: true })
  }, [params, setParams])

  const revealSeek = useCallback(
    (jobId: string | null) => {
      setFilter('all')
      if (jobId && selectedJob !== 'all' && jobId !== selectedJob) selectJob(jobId)
    },
    [selectJob, selectedJob],
  )

  function startWith(text: string) {
    saveDraft(room.id, text)
    setComposerKey((value) => value + 1)
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('.bold-room-composer textarea')?.focus(),
    )
  }

  // A slash command from Search (`/b?command=assign`) loads into the same composer the prototype's menu feeds.
  useEffect(() => {
    if (!command) return
    saveDraft(room.id, `/${command} `)
    const next = new URLSearchParams(params)
    next.delete('command')
    setParams(next, { replace: true })
    requestAnimationFrame(() => {
      const box = document.querySelector<HTMLTextAreaElement>('.bold-room-composer textarea')
      box?.focus()
      box?.setSelectionRange(box.value.length, box.value.length)
    })
  }, [command, params, room.id, setParams])

  return (
    <>
      {jobsStatus === 'pending' && (
        <p className="bold-stream-note" role="status">
          Loading jobs…
        </p>
      )}
      {jobsStatus === 'error' && (
        <p className="bold-stream-note" role="alert">
          Couldn’t load jobs. Try again.
        </p>
      )}
      {jobsStatus === 'success' && !empty && (
        <RoomTabs
          jobs={allJobs}
          selectedJob={selectedJob}
          filter={filter}
          onSelectJob={selectJob}
          onSelectFilter={selectFilter}
          onOpenThread={onOpenThread}
        />
      )}
      {jobsStatus === 'success' && !empty && (
        <div className="bold-room-tools">
          <button
            type="button"
            className="bold-filter bold-deleted-toggle"
            aria-pressed={showDeleted}
            onClick={() => setShowDeleted(room.id, !showDeleted)}
          >
            {showDeleted ? 'Hide deleted messages' : 'Show deleted messages'}
          </button>
        </div>
      )}
      {!empty && (
        <RoomRequests
          roomId={room.id}
          jobs={allJobs}
          agents={agents}
          selectedJob={selectedJob}
          messages={baseMessages.data?.items ?? []}
        />
      )}
      {empty ? (
        <RoomEmpty agents={agents} onStart={startWith} />
      ) : (
        <div className="stream" id="bold-room-stream" aria-live="polite">
          <RoomCapsules
            jobs={allJobs}
            agents={agents}
            selectedJob={selectedJob}
            filter={filter}
            onOpenThread={onOpenThread}
          />
          <RoomMessageStream
            roomId={room.id}
            jobs={allJobs}
            agents={agents}
            selectedJob={selectedJob}
            filter={filter}
            showDeleted={showDeleted}
            seek={seek}
            openedJobs={opened}
            onRevealSeek={revealSeek}
            onSeeked={clearSeek}
          />
        </div>
      )}
      <div className="bold-room-composer">
        <Composer
          key={`${composerKey}-${command ?? ''}`}
          roomId={room.id}
          roomName={room.name}
          agents={agents}
          leadAgentId={room.leadAgentId}
          jobId={selectedJob === 'all' ? null : selectedJob}
          roomMode
          toLabel={toLabel}
          placeholder={
            empty ? 'Describe the work' : 'Message the team. @name for one agent, / for commands'
          }
          messagesKey={baseMessagesDefinition.key}
          initialText={command ? `/${command} ` : undefined}
          onSent={() => {
            if (!params.has('message')) return
            const next = new URLSearchParams(params)
            next.delete('message')
            setParams(next, { replace: true })
          }}
        />
      </div>
    </>
  )
}

/** The room column of the bold shell: its title, job tabs, requests, live stream and composer. */
export function BoldTeamRoom({
  agents,
  phoneAction,
  onOpenThread = () => undefined,
}: {
  agents: AgentSummary[]
  phoneAction?: ReactNode
  onOpenThread?: (jobId: string) => void
}) {
  const [params] = useSearchParams()
  const override = params.get('room')
  const definition = useMemo(() => teamRoomQuery(override), [override])
  const { data: room, status } = useStreamQuery(definition)
  const name = room?.name ?? 'Team room'

  // The head (and the phone's side-panel button) stays mounted across loading, error and ready, so focus on that
  // button survives the room's first read.
  return (
    <>
      <RoomTitle name={name} action={phoneAction} />
      {status === 'pending' ? (
        <RoomWaiting />
      ) : status === 'error' || !room ? (
        <RoomUnavailable error={status === 'error'} />
      ) : (
        <LoadedTeamRoom room={room} agents={agents} onOpenThread={onOpenThread} />
      )}
    </>
  )
}
