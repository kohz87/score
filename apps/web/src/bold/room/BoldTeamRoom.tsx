import {
  JobSchema,
  type AgentSummary,
  type Job,
  type OutsideSession,
  type Room,
} from '@score/contract'
import { useQueryClient } from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { useStream, useStreamQuery } from '../../data/query-client.ts'
import { agentDisplayName, canTalkTo } from '../bold-agents.ts'
import { DeleteRoomDialog } from '../../routes/chat/DeleteRoomDialog.tsx'
import { ShareDialog } from '../../routes/chat/ShareDialog.tsx'
import { useShowDeleted } from '../../routes/chat/deleted-toggle.ts'
import { roomsQuery } from '../../routes/chat/queries.ts'
import '../../routes/chat/chat.css'
import { Composer } from '../../routes/chat/Composer.tsx'
import { saveDraft } from '../../routes/chat/composer-model.ts'
import { RoomCapsules } from './RoomCapsules.tsx'
import { RoomEmpty } from './RoomEmpty.tsx'
import { RoomMessageStream } from './RoomMessageStream.tsx'
import { RoomRequests } from './RoomRequests.tsx'
import { ReportBackLine } from './ReportBack.tsx'
import {
  DeleteJobDialog,
  JobMenu,
  RenameJobDialog,
  RoomTitle,
  jobLifecycleError,
} from './RoomMenus.tsx'
import { PhoneJobList } from './PhoneJobList.tsx'
import { useFollowEnd } from './follow-end.ts'
import { beginJobUndo } from './job-undo.ts'
import { isEveryoneRoom } from './room-model.ts'
import { ContextBar } from './ContextBar.tsx'
import { useTopicCommands } from './topic-commands.ts'
import type { SystemLine } from './topic-divider.tsx'
import {
  changeCachedJob,
  roomChatMessagesQuery,
  roomJobsQuery,
  teamRoomQuery,
  teamRoomsQuery,
} from './room-queries.ts'
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
      <ReportBackLine job={job} />
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
  onOpenThread,
  externalDeletedNotice,
}: {
  room: Room
  agents: AgentSummary[]
  allJobs: Job[]
  jobsStatus: 'pending' | 'success' | 'error'
  phone: boolean
  /** The one job the phone chat shows. The head and the body both read this, so they cannot disagree. */
  phoneJob?: Job
  phoneJobMissing: boolean
  onOpenThread: (jobId: string) => void
  /** The shell already owns the deletion notice when the room is mounted inside it. */
  externalDeletedNotice: boolean
}) {
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const defaultJobId = allJobs.find((job) => job.isDefault)?.id ?? null
  const [systemLines, setSystemLines] = useState<SystemLine[]>([])
  const [composerKey, setComposerKey] = useState(0)
  const [phoneClosedList, setPhoneClosedList] = useState(false)
  const [sharingJob, setSharingJob] = useState<Job | null>(null)
  const [renamingJob, setRenamingJob] = useState<Job | null>(null)
  const [deletingJob, setDeletingJob] = useState<Job | null>(null)
  const [lifecycleBusy, setLifecycleBusy] = useState<string | null>(null)
  const [lifecycleNotice, setLifecycleNotice] = useState<{
    job: Job
    text: string
    stillWorking: boolean
  } | null>(null)
  const queryClient = useQueryClient()
  const composerFocusFrame = useRef<number | null>(null)
  const allJobsRef = useRef(allJobs)
  const showDeleted = useShowDeleted(room.id)
  const requestedJob = params.get('job') ?? 'all'
  // The topic the person picked (Info, a divider, a link). A topic that no longer exists falls back to none during
  // render: an effect that cleared the address would set state synchronously in an effect.
  const picked = requestedJob === 'all' ? undefined : allJobs.find((job) => job.id === requestedJob)
  const selectedJob =
    phone && !phoneJob
      ? 'all'
      : picked
        ? picked.id
        : jobsStatus !== 'success'
          ? requestedJob
          : 'all'
  // The current topic: the one picked, else the newest open one, else the chat's general conversation.
  const openTopic = [...allJobs]
    .filter((job) => !job.isDefault && job.state !== 'done' && job.state !== 'closed')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const currentJob = picked ?? openTopic ?? allJobs.find((job) => job.isDefault)
  const seek = params.get('message')
  const command = params.get('command')
  const stream = useStream()
  const streamRef = useFollowEnd(`${room.id}:chat`, seek !== null)

  // The message page the composer writes into: the selected job, or the room's default job from All. Its query key
  // does not depend on the room's job list, so a new job never refetches it or drops an optimistic message.
  const composerJobId = currentJob && !currentJob.isDefault ? currentJob.id : null
  const baseMessagesDefinition = useMemo(
    () => roomChatMessagesQuery(room.id, null, defaultJobId),
    [defaultJobId, room.id],
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
      const next = new URLSearchParams(params)
      if (jobId === 'all') next.delete('job')
      else next.set('job', jobId)
      next.delete('message')
      next.delete('jobs')
      // A file belongs to the job it was opened from; another job must not inherit it.
      if (jobId !== leaving) next.delete('file')
      // On a phone, opening a job from the list is a step Back undoes; moving from one job to another replaces it and
      // keeps that entry's mark, so Back still lands on the list.
      if (phone && !leaving) {
        const previous = (location.state as Record<string, unknown> | null) ?? {}
        setParams(next, { state: { ...previous, phoneJobFromList: true } })
      } else setParams(next, { replace: true, state: location.state })
    },
    [location.state, params, phone, setParams],
  )

  useEffect(() => {
    allJobsRef.current = allJobs
  }, [allJobs])

  // A delete from another tab (or another device) takes the open job with it; this tab returns to All and says why.
  useEffect(
    () =>
      stream.subscribe((event) => {
        if (event.type !== 'job.deleted') return
        const open = params.get('job')
        if (open !== event.data.id) return
        const next = new URLSearchParams(params)
        next.delete('job')
        next.delete('message')
        // The Workbench and Results views of that job go with it.
        next.delete('work')
        next.delete('file')
        setParams(next, { replace: true, state: location.state })
        if (!externalDeletedNotice)
          setLifecycleNotice({
            job: allJobsRef.current.find((job) => job.id === event.data.id) ?? {
              id: event.data.id,
              roomId: event.data.roomId,
              title: 'Deleted job',
              state: 'open',
              holderAgentId: null,
              isDefault: false,
              exchangeBudget: 8,
              jobTurnLimit: 40,
              unread: 0,
              activeAgents: [],
              lastMessageAt: null,
              messageCount: 0,
              summary: null,
              source: null,
              reportBack: null,
              spendCapUsd: null,
              recipe: null,
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
            },
            text: 'That job was deleted.',
            stillWorking: false,
          })
      }),
    [externalDeletedNotice, location.state, params, setParams, stream],
  )

  async function changeJobState(job: Job, action: 'close' | 'reopen') {
    setLifecycleBusy(job.id)
    setLifecycleNotice(null)
    try {
      const changed = JobSchema.parse(
        await apiFetch(`jobs/${encodeURIComponent(job.id)}/${action}`, {
          method: 'POST',
          headers: { 'Idempotency-Key': newId() },
          body: '{}',
        }),
      )
      changeCachedJob(queryClient, changed, 'upsert')
      if (action === 'close') {
        if (selectedJob === job.id) selectJob('all')
        setLifecycleNotice({
          job: changed,
          text: `Closed “${changed.title}”. Reopen it from its topic menu.`,
          stillWorking: false,
        })
      } else {
        setPhoneClosedList(false)
        selectJob(changed.id)
        setLifecycleNotice({
          job: changed,
          text: `Reopened “${changed.title}”.`,
          stillWorking: false,
        })
      }
    } catch (failure) {
      const problem = jobLifecycleError(failure, action)
      setLifecycleNotice({ job, text: problem.text, stillWorking: problem.stillWorking })
    } finally {
      setLifecycleBusy(null)
    }
  }

  async function stopForLifecycle(job: Job) {
    setLifecycleBusy(job.id)
    try {
      await apiFetch(`jobs/${encodeURIComponent(job.id)}/stop`, {
        method: 'POST',
        headers: { 'Idempotency-Key': newId() },
        body: '{}',
      })
      setLifecycleNotice({
        job,
        text: 'Stop sent. Close or delete the job again once it has stopped.',
        stillWorking: false,
      })
    } catch (failure) {
      const problem = jobLifecycleError(failure, 'close')
      setLifecycleNotice({ job, text: problem.text, stillWorking: true })
    } finally {
      setLifecycleBusy(null)
    }
  }

  async function reopenForComposer(jobId: string) {
    const reopened = JobSchema.parse(
      await apiFetch(`jobs/${encodeURIComponent(jobId)}/reopen`, {
        method: 'POST',
        headers: { 'Idempotency-Key': newId() },
        body: '{}',
      }),
    )
    changeCachedJob(queryClient, reopened, 'upsert')
    // The composer retries the message after this resolves. Keep this job selected so
    // the retry still goes into it instead of falling back to the room's default thread.
    setPhoneClosedList(false)
    if (selectedJob !== jobId) selectJob(jobId)
  }

  function jobDeleted(job: Job) {
    setDeletingJob(null)
    changeCachedJob(queryClient, job, 'delete')
    if (selectedJob === job.id) selectJob('all')
    beginJobUndo(queryClient, job)
  }

  const namedJobs = allJobs.filter((job) => !job.isDefault)
  const empty =
    jobsStatus === 'success' &&
    namedJobs.length === 0 &&
    baseMessages.status === 'success' &&
    (baseMessages.data?.items.length ?? 0) === 0 &&
    // Turned on, the deleted markers show where the starter board would be (every message may have been deleted).
    !showDeleted &&
    // An older or imported phone room is still a chat: its one job must be reachable even before any message.
    !(phone && room.role !== 'team')
  const job = picked
  const lead = agents.find((agent) => agent.id === room.leadAgentId)
  // Removed agents stay in `agents` for the history's names; @ and To offer only agents that can take a message (3.7.10).
  const talkable = useMemo(() => agents.filter(canTalkTo), [agents])
  const olderRoom = room.role !== 'team' && room.routing === 'mentions'
  const toLabel = lead ? `To: ${agentDisplayName(lead)}` : 'No lead yet — use @name'

  const clearSeek = useCallback(() => {
    const next = new URLSearchParams(params)
    if (!next.has('message')) return
    next.delete('message')
    setParams(next, { replace: true, state: location.state })
  }, [location.state, params, setParams])

  const topicCommands = useTopicCommands({
    room,
    agents,
    jobs: allJobs,
    current: currentJob,
    pick: (jobId) => {
      const next = new URLSearchParams(params)
      if (jobId) next.set('job', jobId)
      else next.delete('job')
      next.delete('message')
      next.delete('jobs')
      setParams(next, { replace: true, state: location.state })
    },
    say: (text) =>
      setSystemLines((lines) => [...lines, { id: newId(), at: new Date().toISOString(), text }]),
  })

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
      {lifecycleNotice && (
        <div
          className="bold-job-lifecycle-notice"
          data-protected="block"
          role={lifecycleNotice.stillWorking ? 'alert' : 'status'}
        >
          <span>{lifecycleNotice.text}</span>
          {lifecycleNotice.stillWorking && (
            <button
              type="button"
              className="btn sm"
              disabled={lifecycleBusy === lifecycleNotice.job.id}
              onClick={() => void stopForLifecycle(lifecycleNotice.job)}
            >
              {lifecycleBusy === lifecycleNotice.job.id ? 'Stopping…' : 'Stop'}
            </button>
          )}
          <button
            type="button"
            className="link"
            aria-label="Dismiss job notice"
            onClick={() => setLifecycleNotice(null)}
          >
            Dismiss
          </button>
        </div>
      )}
      <RoomRequests
        roomId={room.id}
        jobs={allJobs}
        agents={agents}
        selectedJob="all"
        teamRoom={isEveryoneRoom(room)}
        messages={baseMessages.data?.items ?? []}
      />
      {phone && room.role === 'team' && phoneJobMissing ? (
        <PhoneJobList
          jobs={allJobs}
          agents={agents}
          onOpen={selectJob}
          closedOnly={phoneClosedList}
          onShowClosed={() => setPhoneClosedList((shown) => !shown)}
        />
      ) : empty ? (
        <>
          <RoomEmpty agents={agents} onStart={startWith} />
        </>
      ) : phone && room.role === 'team' && !phoneJob ? (
        <PhoneJobList
          jobs={allJobs}
          agents={agents}
          onOpen={selectJob}
          closedOnly={phoneClosedList}
          onShowClosed={() => setPhoneClosedList((shown) => !shown)}
        />
      ) : phone && room.role !== 'team' && !phoneJob && jobsStatus !== 'success' ? (
        <p className="bold-stream-note" role="status">
          Opening the room…
        </p>
      ) : (
        <div className="stream" id="bold-room-stream" ref={streamRef}>
          {job && <StartedBy job={job} />}
          {/* On a phone the capsule (and its Take it aside) sits in the open job's chat, as the prototype shows it. */}
          {(!phone || phoneJob) && (
            <RoomCapsules jobs={allJobs} agents={agents} onOpenThread={onOpenThread} />
          )}
          <RoomMessageStream
            roomId={room.id}
            jobs={allJobs}
            agents={agents}
            showDeleted={showDeleted}
            seek={seek}
            focusTopic={picked?.id ?? null}
            systemLines={systemLines}
            topicMenu={(topic) => (
              <JobMenu
                room={room}
                job={topic}
                onShare={setSharingJob}
                onRename={setRenamingJob}
                onCloseJob={(target) => void changeJobState(target, 'close')}
                onReopen={(target) => void changeJobState(target, 'reopen')}
                onDelete={setDeletingJob}
              />
            )}
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
          offered={talkable}
          leadAgentId={room.leadAgentId}
          jobId={composerJobId}
          roomMode
          toLabel={toLabel}
          placeholder={
            empty
              ? 'Describe the work'
              : olderRoom
                ? 'Message this room'
                : 'Message the chat · @ someone · / for commands'
          }
          topicCommands={olderRoom ? undefined : topicCommands}
          footer={({ to, subject }) => (
            <ContextBar
              to={to}
              subjectId={subject}
              agents={agents}
              ownerId={room.leadAgentId}
              topic={currentJob}
            />
          )}
          messagesKey={baseMessagesDefinition.key}
          initialText={command ? `/${command} ` : undefined}
          onClosedJob={reopenForComposer}
          onSent={() => {
            if (!params.has('message')) return
            const next = new URLSearchParams(params)
            next.delete('message')
            setParams(next, { replace: true, state: location.state })
          }}
        />
      </div>
      {sharingJob && <ShareDialog room={room} job={sharingJob} close={() => setSharingJob(null)} />}
      {renamingJob && (
        <RenameJobDialog
          job={renamingJob}
          onClose={() => setRenamingJob(null)}
          onRenamed={(renamed) => {
            changeCachedJob(queryClient, renamed, 'upsert')
            setLifecycleNotice({
              job: renamed,
              text: `Renamed “${renamed.title}”.`,
              stillWorking: false,
            })
            setRenamingJob(null)
          }}
        />
      )}
      {deletingJob && (
        <DeleteJobDialog
          job={deletingJob}
          onClose={() => setDeletingJob(null)}
          onDeleted={() => jobDeleted(deletingJob)}
          onStop={(job) => {
            setDeletingJob(null)
            void stopForLifecycle(job)
          }}
        />
      )}
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
  externalDeletedNotice = false,
  chatMeta,
  chatAction,
  onChatInfo,
  infoRef,
  infoExpanded,
  onBackToChats,
}: {
  agents: AgentSummary[]
  /** 3.21.0 desktop chat bar: the owner/members line under the name, and the Chat info button after the menus. */
  chatMeta?: (room: Room) => ReactNode
  chatAction?: (room: Room) => ReactNode
  /** 3.21.0 phone chat bar: the round Info button (it opens the side sheet), its ref, and the way back to the list. */
  onChatInfo?: () => void
  infoRef?: RefObject<HTMLButtonElement | null>
  infoExpanded?: boolean
  onBackToChats?: () => void
  /** The bold shell's phone breakpoint: board 18's job list and board 03's full-screen chat. */
  phone?: boolean
  phoneAction?: ReactNode
  onOpenElsewhere?: (session: OutsideSession) => void
  onOpenThread?: (jobId: string) => void
  /** The shell already owns the deletion notice when the room is mounted inside it. */
  externalDeletedNotice?: boolean
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
  const teamJobCount =
    teamRead?.jobs.filter((job) => !job.isDefault && job.state !== 'closed').length ?? null
  const rooms = useStreamQuery(roomsQuery).data?.rooms ?? []
  const teamRooms = useStreamQuery(teamRoomsQuery).data ?? []
  const current =
    room ??
    (override === null
      ? teamRoom
      : (rooms.find((item) => item.id === override) ??
        teamRooms.find((item) => item.id === override) ??
        null))
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
  // 3.21.0: a phone chat opens straight into its conversation (the default job); the job list is one step away
  // (`?jobs=1`, from the Info sheet) and a named job is `?job=`.
  const jobsView = params.get('jobs') === '1'
  const phoneJob = phoneRoom
    ? jobsView
      ? undefined
      : current?.role === 'team' && requestedPhoneJobId !== null && requestedPhoneJobId !== 'all'
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
    if (jobsView) {
      const next = new URLSearchParams(params)
      next.delete('jobs')
      setParams(next, { replace: true })
      return
    }
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
    if (isEveryoneRoom(target)) next.delete('room')
    else next.set('room', target.id)
    next.delete('job')
    // Picking a chat from the job list's switcher opens that chat's conversation, not its job list.
    next.delete('jobs')
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
        phoneBackLabel="Back to chat"
        onBackToJobs={backToJobs}
        phoneList={jobsView || phoneJobMissing}
        onBackToChats={onBackToChats}
        onChatInfo={onChatInfo}
        infoRef={infoRef}
        infoExpanded={infoExpanded}
        chatMeta={chatMeta}
        chatAction={chatAction}
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
          onOpenThread={onOpenThread}
          externalDeletedNotice={externalDeletedNotice}
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
