import type { AgentSummary, Job, OutsideSession, Room } from '@score/contract'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { useStreamQuery } from '../../data/query-client.ts'
import { DeleteRoomDialog } from '../../routes/chat/DeleteRoomDialog.tsx'
import { ShareDialog } from '../../routes/chat/ShareDialog.tsx'
import { useShowDeleted, setShowDeleted } from '../../routes/chat/deleted-toggle.ts'
import { roomsQuery } from '../../routes/chat/queries.ts'
import '../../routes/chat/chat.css'
import { Composer } from '../../routes/chat/Composer.tsx'
import { saveDraft } from '../../routes/chat/composer-model.ts'
import { RoomCapsules } from './RoomCapsules.tsx'
import { RoomEmpty } from './RoomEmpty.tsx'
import { RoomMessageStream } from './RoomMessageStream.tsx'
import { RoomRequests } from './RoomRequests.tsx'
import { RoomTabs } from './RoomTabs.tsx'
import { JobMenu, RoomMenu, RoomTitle } from './RoomMenus.tsx'
import { PhoneJobList } from './PhoneJobList.tsx'
import { jobMatchesFilter, type JobFilter } from './room-model.ts'
import { roomJobsQuery, roomMessagesQuery, teamRoomQuery } from './room-queries.ts'
import './bold-room.css'

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

function sourceLink(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

/** Where a trigger-started job came from. Its text is outside content, never an instruction to the agents. */
function StartedBy({ job }: { job: Job }) {
  const source = job.source
  if (!source) return null
  const link = sourceLink(source.link)
  return (
    <article className="bold-source" data-protected="block" aria-label={`Started by ${source.app}`}>
      <span className="bold-source-head">
        Started by <b>{source.app}</b> through a trigger
      </span>
      <span className="bold-source-line">
        <span className="bold-source-badge">
          {source.app} · {source.ref}
        </span>
        {source.title && <span>{source.title}</span>}
      </span>
      {link && (
        <a className="bold-source-open" href={link} target="_blank" rel="noreferrer">
          Open in {source.app} ↗
        </a>
      )}
      {source.missing.length > 0 && (
        <span className="bold-source-missing">
          Missing from the call: {source.missing.join(', ')}
        </span>
      )}
      <span className="bold-source-note">
        The ticket’s text reaches agents quoted as outside content, never as instructions.
      </span>
    </article>
  )
}

function LoadedTeamRoom({
  room,
  agents,
  allJobs,
  jobsStatus,
  phone,
  phoneJob,
  phoneJobMissing,
  phoneAction,
  onShareRoom,
  onDeleteRoom,
  onOpenThread,
}: {
  room: Room
  agents: AgentSummary[]
  allJobs: Job[]
  jobsStatus: 'pending' | 'success' | 'error'
  phone: boolean
  /** The one job the phone chat shows. The head and the body both read this, so they cannot disagree. */
  phoneJob?: Job
  phoneJobMissing: boolean
  phoneAction?: ReactNode
  onShareRoom: (room: Room) => void
  onDeleteRoom: (room: Room) => void
  onOpenThread: (jobId: string) => void
}) {
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const defaultJobId = allJobs.find((job) => job.isDefault)?.id ?? null
  const [filter, setFilter] = useState<JobFilter>('all')
  const [composerKey, setComposerKey] = useState(0)
  const [openedJobs, setOpenedJobs] = useState<string[]>([])
  const [sharingJob, setSharingJob] = useState<Job | null>(null)
  const composerFocusFrame = useRef<number | null>(null)
  const showDeleted = useShowDeleted(room.id)
  const requestedJob = params.get('job') ?? 'all'
  // A tab that no longer exists, or that the D10 filter hides, falls back to All during render: an effect that called
  // selectJob would set state synchronously in an effect (and cascade a second render for the same event).
  const requested =
    requestedJob === 'all' ? undefined : allJobs.find((job) => job.id === requestedJob)
  const selectedJob = phone
    ? (phoneJob?.id ?? 'all')
    : requestedJob === 'all'
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

  const focusComposer = useCallback(() => {
    if (composerFocusFrame.current !== null) cancelAnimationFrame(composerFocusFrame.current)
    composerFocusFrame.current = requestAnimationFrame(() => {
      composerFocusFrame.current = null
      document.querySelector<HTMLTextAreaElement>('.bold-room-composer textarea')?.focus()
    })
  }, [])

  useEffect(
    () => () => {
      if (composerFocusFrame.current !== null) cancelAnimationFrame(composerFocusFrame.current)
    },
    [],
  )

  const selectJob = useCallback(
    (jobId: string) => {
      const leaving = params.get('job')
      if (leaving)
        setOpenedJobs((current) => (current.includes(leaving) ? current : [...current, leaving]))
      const next = new URLSearchParams(params)
      if (jobId === 'all') next.delete('job')
      else next.set('job', jobId)
      next.delete('message')
      // On a phone, opening a job from the list is a step Back undoes; moving from one job to another replaces it and
      // keeps that entry's mark, so Back still lands on the list.
      if (phone && !leaving) {
        const previous = (location.state as Record<string, unknown> | null) ?? {}
        setParams(next, { state: { ...previous, phoneJobFromList: true } })
      } else setParams(next, { replace: true, state: location.state })
    },
    [location.state, params, phone, setParams],
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
    (baseMessages.data?.items.length ?? 0) === 0 &&
    // An older or imported phone room is still a chat: its one job must be reachable even before any message.
    !(phone && room.role !== 'team')
  const job = allJobs.find((item) => item.id === selectedJob)
  const lead = agents.find((agent) => agent.id === room.leadAgentId)
  const olderRoom = room.role !== 'team' && room.routing === 'mentions'
  const allLabel = olderRoom
    ? 'Older room · @name'
    : lead
      ? `To: team room (${lead.name})`
      : 'No lead yet — use @name'
  const toLabel = job ? `To: ${job.title}` : allLabel

  const clearSeek = useCallback(() => {
    const next = new URLSearchParams(params)
    if (!next.has('message')) return
    next.delete('message')
    setParams(next, { replace: true, state: location.state })
  }, [location.state, params, setParams])

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
    focusComposer()
  }

  // A slash command from Search (`/b?command=assign`) loads into the same composer the prototype's menu feeds.
  useEffect(() => {
    if (!command) return
    saveDraft(room.id, `/${command} `)
    const next = new URLSearchParams(params)
    next.delete('command')
    setParams(next, { replace: true, state: location.state })
    focusComposer()
  }, [command, focusComposer, location.state, params, room.id, setParams])

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
      {phoneJobMissing && (
        <p className="bold-stream-note" role="status">
          That job isn’t here any more.
        </p>
      )}
      {phone && phoneJob && (
        <div className="bold-phone-chat-tools" aria-label="Job tools">
          <button
            type="button"
            className="bold-job-thread"
            aria-label={`Open thread for ${phoneJob.title}`}
            onClick={() => onOpenThread(phoneJob.id)}
          >
            Thread
          </button>
          <JobMenu room={room} job={phoneJob} onShare={setSharingJob} />
          {room.role !== 'team' && (
            <RoomMenu room={room} onShare={onShareRoom} onDelete={onDeleteRoom} />
          )}
          <button
            type="button"
            className="bold-filter bold-deleted-toggle"
            aria-pressed={showDeleted}
            onClick={() => setShowDeleted(room.id, !showDeleted)}
          >
            {showDeleted ? 'Hide deleted messages' : 'Show deleted messages'}
          </button>
          {phoneAction}
        </div>
      )}
      {!phone && jobsStatus === 'success' && !empty && (
        <RoomTabs
          jobs={allJobs}
          selectedJob={selectedJob}
          filter={filter}
          onSelectJob={selectJob}
          onSelectFilter={selectFilter}
          trailing={<JobMenu room={room} job={job} onShare={setSharingJob} />}
          onOpenThread={onOpenThread}
        />
      )}
      {!phone && jobsStatus === 'success' && !empty && (
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
      {phone && room.role === 'team' && phoneJobMissing ? (
        <PhoneJobList jobs={allJobs} agents={agents} onOpen={selectJob} />
      ) : empty ? (
        <RoomEmpty agents={agents} onStart={startWith} />
      ) : phone && room.role === 'team' && !phoneJob ? (
        <PhoneJobList jobs={allJobs} agents={agents} onOpen={selectJob} />
      ) : phone && room.role !== 'team' && !phoneJob && jobsStatus !== 'success' ? (
        <p className="bold-stream-note" role="status">
          Opening the room…
        </p>
      ) : (
        <div className="stream" id="bold-room-stream" aria-live="polite">
          {job && <StartedBy job={job} />}
          {!phone && (
            <RoomCapsules
              jobs={allJobs}
              agents={agents}
              selectedJob={selectedJob}
              filter={filter}
              onOpenThread={onOpenThread}
            />
          )}
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
          jobId={selectedJob === 'all' || (phone && !phoneJob) ? null : selectedJob}
          roomMode
          toLabel={toLabel}
          placeholder={
            empty
              ? 'Describe the work'
              : phone
                ? phoneJob
                  ? 'Message the team'
                  : 'Start a job or message the team'
                : olderRoom
                  ? 'Message this room. @name for one agent, / for commands'
                  : 'Message the team. @name for one agent, / for commands'
          }
          messagesKey={baseMessagesDefinition.key}
          initialText={command ? `/${command} ` : undefined}
          onSent={() => {
            if (!params.has('message')) return
            const next = new URLSearchParams(params)
            next.delete('message')
            setParams(next, { replace: true, state: location.state })
          }}
        />
      </div>
      {sharingJob && <ShareDialog room={room} job={sharingJob} close={() => setSharingJob(null)} />}
    </>
  )
}

/** The room column of the bold shell: its title, job tabs, requests, live stream and composer. */
export function BoldTeamRoom({
  agents,
  phone = false,
  phoneAction,
  onOpenElsewhere,
  onOpenThread = () => undefined,
}: {
  agents: AgentSummary[]
  /** The bold shell's phone breakpoint: board 18's job list and board 03's full-screen chat. */
  phone?: boolean
  phoneAction?: ReactNode
  onOpenElsewhere?: (session: OutsideSession) => void
  onOpenThread?: (jobId: string) => void
}) {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const override = params.get('room')
  const definition = useMemo(() => teamRoomQuery(override), [override])
  const { data: roomRead, status } = useStreamQuery(definition)
  const room = roomRead?.room ?? null
  const teamDefinition = useMemo(() => teamRoomQuery(null), [])
  const { data: teamRead } = useStreamQuery(teamDefinition)
  const teamRoom = teamRead?.room ?? null
  const teamJobCount = teamRead?.jobs.filter((job) => !job.isDefault).length ?? null
  const rooms = useStreamQuery(roomsQuery).data?.rooms ?? []
  const current =
    room ?? (override === null ? teamRoom : (rooms.find((item) => item.id === override) ?? null))
  const jobsDefinition = useMemo(() => roomJobsQuery(current?.id ?? null), [current?.id])
  const { data: jobs, status: jobsStatus } = useStreamQuery(jobsDefinition)
  const allJobs = useMemo(() => jobs ?? [], [jobs])
  const [sharing, setSharing] = useState<{ room: Room; job?: Job } | null>(null)
  const [deleting, setDeleting] = useState<Room | null>(null)
  const previousPhoneJob = useRef<string | null>(null)
  const phoneRoom = phone && current !== null
  const requestedPhoneJobId = params.get('job')
  const requestedPhoneJob =
    requestedPhoneJobId && requestedPhoneJobId !== 'all'
      ? allJobs.find((job) => job.id === requestedPhoneJobId)
      : undefined
  const phoneDefaultJob = allJobs.find((job) => job.isDefault) ?? allJobs[0]
  // A phone team room lists its jobs; an older or imported room has one job, so it opens straight into that chat.
  const phoneJob = phoneRoom
    ? current?.role === 'team'
      ? requestedPhoneJob
      : (requestedPhoneJob ?? phoneDefaultJob)
    : undefined
  const phoneJobId = phoneJob?.id ?? null
  const phoneJobMissing =
    phoneRoom &&
    current?.role === 'team' &&
    requestedPhoneJobId !== null &&
    requestedPhoneJobId !== 'all' &&
    jobsStatus === 'success' &&
    !requestedPhoneJob

  useEffect(() => {
    if (!phone || !phoneJobId) return
    const frame = requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('[data-phone-chat-title]')?.focus(),
    )
    return () => cancelAnimationFrame(frame)
  }, [phone, phoneJobId])

  // Back (the button or the browser's) returns focus to the row of the job it left.
  useEffect(() => {
    if (!phone) return
    if (phoneJobId) {
      previousPhoneJob.current = phoneJobId
      return
    }
    const leftJob = previousPhoneJob.current
    if (!leftJob) return
    previousPhoneJob.current = null
    const frame = requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`[data-phone-job-id=${JSON.stringify(leftJob)}]`)
        ?.focus(),
    )
    return () => cancelAnimationFrame(frame)
  }, [phone, phoneJobId])

  const backToJobs = () => {
    if (current?.role !== 'team') {
      const next = new URLSearchParams(params)
      next.delete('room')
      next.delete('job')
      next.delete('message')
      setParams(next)
      return
    }
    if ((location.state as { phoneJobFromList?: boolean } | null)?.phoneJobFromList) {
      navigate(-1)
      return
    }
    const next = new URLSearchParams(params)
    next.delete('job')
    next.delete('message')
    setParams(next, { replace: true })
  }

  const selectRoom = (target: Room) => {
    const next = new URLSearchParams(params)
    if (target.role === 'team') next.delete('room')
    else next.set('room', target.id)
    next.delete('job')
    next.delete('message')
    next.delete('command')
    setParams(next)
  }

  const returnToTeam = () => {
    const next = new URLSearchParams(params)
    next.delete('room')
    next.delete('job')
    next.delete('message')
    next.delete('command')
    setParams(next)
  }

  // The head (and the phone's side-panel button) stays mounted across loading, error and ready, so focus on that
  // button survives the room's first read.
  return (
    <>
      <RoomTitle
        current={current}
        teamRoom={teamRoom}
        teamJobCount={teamJobCount}
        rooms={rooms}
        agents={agents}
        phoneAction={phoneAction}
        phone={phoneRoom}
        phoneJob={phoneJob}
        phoneBackLabel={current?.role === 'team' ? 'Back to jobs' : 'Back to the team room'}
        onBackToJobs={backToJobs}
        onSelectRoom={selectRoom}
        onOpenElsewhere={(session) => onOpenElsewhere?.(session)}
        onShare={(room) => {
          const jobId = params.get('job')
          const job =
            room.role === 'team' && jobId && jobId !== 'all'
              ? allJobs.find((item) => item.id === jobId)
              : undefined
          setSharing({ room, job })
        }}
        onDelete={setDeleting}
      />
      {status === 'pending' ? (
        <RoomWaiting />
      ) : status === 'error' || !room ? (
        <RoomUnavailable error={status === 'error'} />
      ) : (
        <LoadedTeamRoom
          key={room.id}
          room={room}
          agents={agents}
          allJobs={allJobs}
          jobsStatus={jobsStatus}
          phone={phoneRoom}
          phoneJob={phoneJob}
          phoneJobMissing={phoneJobMissing}
          phoneAction={phoneAction}
          onShareRoom={(target) => setSharing({ room: target })}
          onDeleteRoom={setDeleting}
          onOpenThread={onOpenThread}
        />
      )}
      {sharing && (
        <ShareDialog room={sharing.room} job={sharing.job} close={() => setSharing(null)} />
      )}
      {deleting && (
        <DeleteRoomDialog
          room={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null)
            returnToTeam()
          }}
        />
      )}
    </>
  )
}
