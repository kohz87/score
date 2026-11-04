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
import { useLocation, useSearchParams } from 'react-router'
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
import { currentTopic } from '../chats/chat-model.ts'
import { NeedsSlotsProvider } from './needs-slots.tsx'
import { RoomRequests } from './RoomRequests.tsx'
import { ReportBackLine } from './ReportBack.tsx'
import {
  DeleteJobDialog,
  JobMenu,
  RenameJobDialog,
  RoomTitle,
  jobLifecycleError,
} from './RoomMenus.tsx'
import { useFollowEnd } from './follow-end.ts'
import { beginJobUndo } from './job-undo.ts'
import { holdsSeveralJobs, isActiveJob, isEveryoneRoom, theActiveJob } from './room-model.ts'
import { BusyDialog, type BusyStart } from './BusyDialog.tsx'
import { JobBar, NextUp, PastJobBar } from './JobBar.tsx'
import { useStartJob, type StartJobOptions } from '../BoldStartJob.tsx'
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
  onShowGraph,
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
  onShowGraph: (jobId: string) => void
  /** The shell already owns the deletion notice when the room is mounted inside it. */
  externalDeletedNotice: boolean
}) {
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const defaultJobId = allJobs.find((job) => job.isDefault)?.id ?? null
  const [systemLines, setSystemLines] = useState<SystemLine[]>([])
  const [composerKey, setComposerKey] = useState(0)
  const [sharingJob, setSharingJob] = useState<Job | null>(null)
  const [renamingJob, setRenamingJob] = useState<Job | null>(null)
  const [deletingJob, setDeletingJob] = useState<Job | null>(null)
  const [lifecycleBusy, setLifecycleBusy] = useState<string | null>(null)
  // 3.28.0: starting work while the chat has a job asks first (the busy dialog).
  const [busyStart, setBusyStart] = useState<{
    busy: BusyStart
    options: StartJobOptions
  } | null>(null)
  const startJob = useStartJob()
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
  const currentJob = picked ?? currentTopic(allJobs, null)
  const seek = params.get('message')
  const command = params.get('command')
  const stream = useStream()
  const streamRef = useFollowEnd(`${room.id}:chat`, seek !== null)

  // The message page the composer writes into: the selected job, or the room's default job from All. Its query key
  // does not depend on the room's job list, so a new job never refetches it or drops an optimistic message.
  // A `?job=` that points at a topic whose list hasn't loaded yet must not fall back to the general conversation.
  // Held only while the topics load; a failed read shows its own error and leaves the composer usable.
  const holdForTopic = requestedJob !== 'all' && jobsStatus === 'pending'
  // 3.28.0: one job per chat. A message goes to the chat's active job, else the chat's own thread; only an older chat that
  // still holds several active jobs keeps choosing (the picked one, else the newest).
  const severalJobs = holdsSeveralJobs(allJobs)
  const activeJob = theActiveJob(allJobs)
  const sendJob = severalJobs ? currentJob : (activeJob ?? undefined)
  const composerJobId = sendJob && !sendJob.isDefault ? sendJob.id : null
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
      setParams(next, { replace: true, state: location.state })
    },
    [location.state, params, setParams],
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
        // An older chat keeps the closed job's divider. With one job per chat there is none, so the closed job stays
        // picked: its past-job bar carries the menu the notice points to.
        if (severalJobs) {
          if (selectedJob === job.id) selectJob('all')
        } else selectJob(changed.id)
        setLifecycleNotice({
          job: changed,
          text: `Closed “${changed.title}”. Reopen it from its menu.`,
          stillWorking: false,
        })
      } else {
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

  // The job's ⋯ menu: on the dividers of an older chat that holds several jobs, and on the job bar otherwise.
  const jobMenu = (topic: Job) => (
    <JobMenu
      room={room}
      job={topic}
      onShare={setSharingJob}
      onRename={setRenamingJob}
      onCloseJob={(target) => void changeJobState(target, 'close')}
      onReopen={(target) => void changeJobState(target, 'reopen')}
      onDelete={setDeletingJob}
    />
  )
  // On a phone the chat head already carries the menu of the job it shows.
  const barMenu = (topic: Job) => (phone && phoneJob?.id === topic.id ? undefined : jobMenu(topic))
  // A finished job opened from Past jobs shows its own bar (the menu to reopen, rename or delete it lives there).
  const pastPicked = picked && !picked.isDefault && !isActiveJob(picked) ? picked : null

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
    onBusy: (busy, options) => setBusyStart({ busy, options }),
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
    <NeedsSlotsProvider>
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
      {(activeJob || pastPicked || room.role === 'team') && (
        <div className="bold-job-strip">
          {activeJob && (
            <JobBar
              job={activeJob}
              agents={agents}
              onShowGraph={onShowGraph}
              menu={barMenu(activeJob)}
            />
          )}
          {pastPicked && (
            <PastJobBar job={pastPicked} onShowGraph={onShowGraph} menu={barMenu(pastPicked)} />
          )}
          {room.role === 'team' && <NextUp roomId={room.id} />}
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
      {empty ? (
        <>
          <RoomEmpty agents={agents} onStart={startWith} />
        </>
      ) : phone && !phoneJob && jobsStatus !== 'success' ? (
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
            oneJobPerChat
            systemLines={systemLines}
            topicMenu={jobMenu}
            onSeeked={clearSeek}
            onShowGraph={onShowGraph}
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
          hold={holdForTopic ? 'Loading the job…' : undefined}
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
          footer={({ to, subject, finishedReplies, compactSignal, compactSubject }) => (
            <ContextBar
              finishedReplies={finishedReplies}
              compactSignal={compactSignal}
              compactSubject={compactSubject}
              roomId={room.id}
              to={to}
              subjectId={subject}
              agents={agents}
              ownerId={room.leadAgentId}
              topic={sendJob}
              showTopic={severalJobs}
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
      {busyStart && (
        <BusyDialog
          busy={busyStart.busy}
          onStopAndStart={async () => {
            const options = busyStart.options
            setBusyStart(null)
            startJob?.openStartJob(options)
          }}
          onAnotherChat={() => {
            const { recipeName } = busyStart.options
            setBusyStart(null)
            startJob?.openStartJob({
              pickChat: true,
              exceptRoomId: room.id,
              ...(recipeName ? { recipeName } : {}),
            })
          }}
          onCancel={() => setBusyStart(null)}
        />
      )}
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
    </NeedsSlotsProvider>
  )
}

/** The room column of the bold shell: its title, job tabs, requests, live stream and composer. */
export function BoldTeamRoom({
  agents,
  phone = false,
  onOpenElsewhere,
  onOpenThread = () => undefined,
  onShowGraph = () => undefined,
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
  onOpenElsewhere?: (session: OutsideSession) => void
  onOpenThread?: (jobId: string) => void
  /** 3.23.0: the run card's Show graph; the side panel opens its Graph tab for that topic. */
  onShowGraph?: (jobId: string) => void
  /** The shell already owns the deletion notice when the room is mounted inside it. */
  externalDeletedNotice?: boolean
}) {
  const [params, setParams] = useSearchParams()
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
  // 3.21.0: a phone chat opens straight into its conversation (the default job); a named job is `?job=`. 3.24.0: the
  // job list screen is gone, `?jobs=1` (an old link) opens the Info sheet on Topics (BoldRoom).
  const phoneJob = phoneRoom ? (requestedPhoneJob ?? phoneDefaultJob) : undefined
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
        phone={phoneRoom}
        phoneJob={phoneJob}
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
          onShowGraph={onShowGraph}
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
