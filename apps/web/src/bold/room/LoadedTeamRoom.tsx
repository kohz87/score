import type { AgentSummary, Job, Room } from '@score/contract'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { newId } from '../../data/ids.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { agentDisplayName, canTalkTo } from '../bold-agents.ts'
import { Composer } from '../../routes/chat/Composer.tsx'
import { saveDraft } from '../../routes/chat/composer-model.ts'
import { useShowDeleted } from '../../routes/chat/deleted-toggle.ts'
import { ShareDialog } from '../../routes/chat/ShareDialog.tsx'
import { RoomCapsules } from './RoomCapsules.tsx'
import { RoomEmpty } from './RoomEmpty.tsx'
import { RoomMessageStream } from './RoomMessageStream.tsx'
import { currentTopic } from '../chats/chat-model.ts'
import { NeedsSlotsProvider } from './needs-slots.tsx'
import { RoomRequests } from './RoomRequests.tsx'
import { DeleteJobDialog, JobMenu, RenameJobDialog } from './RoomMenus.tsx'
import { useFollowEnd } from './follow-end.ts'
import {
  activeJobs,
  holdsSeveralJobs,
  isActiveJob,
  isEveryoneRoom,
  theActiveJob,
} from './room-model.ts'
import { BusyDialog, type BusyStart } from './BusyDialog.tsx'
import { useStartJob, type StartJobOptions } from '../BoldStartJob.tsx'
import { ContextBar } from './ContextBar.tsx'
import { useTopicCommands } from './topic-commands.ts'
import type { SystemLine } from './topic-divider.tsx'
import { changeCachedJob, roomChatMessagesQuery } from './room-queries.ts'
import { RoomJobStrip } from './RoomJobStrip.tsx'
import { RoomJobLifecycleNotice } from './RoomJobLifecycleNotice.tsx'
import { StartedBy } from './StartedBy.tsx'
import { useRoomJobLifecycle } from './use-room-job-lifecycle.ts'

/** How long "Stopped …" stays where the job bar was. */
const STOPPED_NOTE_MS = 8000

export function LoadedTeamRoom({
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
  // 3.28.0: starting work while the chat has a job asks first (the busy dialog).
  const [busyStart, setBusyStart] = useState<{
    busy: BusyStart
    options: StartJobOptions
  } | null>(null)
  const startJob = useStartJob()
  const queryClient = useQueryClient()
  const composerFocusFrame = useRef<number | null>(null)
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
  // An older chat that still holds several open jobs shows the newest one's bar, with "+N more open" (3.30.0).
  const openJobList = activeJobs(allJobs)
  // An older chat with several open jobs shows the job you're in: the one Info and the composer use, the picked one
  // else the newest (3.30.0 gate: the bar named one job while Info and the composer named another).
  const barJob =
    activeJob ??
    (currentJob && openJobList.some((job) => job.id === currentJob.id) ? currentJob : null) ??
    openJobList[0] ??
    null
  const moreOpen = Math.max(0, openJobList.length - 1)
  // After Stop job the bar unmounts; its result stays here for a few seconds, or until the next job starts.
  const [stoppedNote, setStoppedNote] = useState<{ jobId: string; text: string } | null>(null)
  useEffect(() => {
    if (!stoppedNote) return
    const timer = window.setTimeout(() => setStoppedNote(null), STOPPED_NOTE_MS)
    return () => window.clearTimeout(timer)
  }, [stoppedNote])
  // The next job starting clears it (adjusted while rendering, not in an effect).
  if (stoppedNote && barJob && barJob.id !== stoppedNote.jobId) setStoppedNote(null)
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

  const {
    lifecycleBusy,
    lifecycleNotice,
    setLifecycleNotice,
    changeJobState,
    stopForLifecycle,
    reopenForComposer,
    jobDeleted,
  } = useRoomJobLifecycle({
    queryClient,
    allJobs,
    params,
    setParams,
    locationState: location.state,
    externalDeletedNotice,
    severalJobs,
    selectedJob,
    selectJob,
    setDeletingJob,
  })

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
  // The bar carries the job's menu on every width: the phone's chat head holds only the chat's own menu (3.28.0 gate).
  const barMenu = (topic: Job) => jobMenu(topic)
  // A finished job opened from Past jobs shows its own bar (the menu to reopen, rename or delete it lives there).
  const pastPicked = picked && !picked.isDefault && !isActiveJob(picked) ? picked : null

  // "+N more open" opens Info on Open jobs (BoldRoom reads `?jobs=open`).
  function showOpenJobs() {
    const next = new URLSearchParams(params)
    next.set('jobs', 'open')
    setParams(next, { replace: true, state: location.state })
  }

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
    say: (text, action) =>
      setSystemLines((lines) => [
        ...lines,
        { id: newId(), at: new Date().toISOString(), text, ...(action ? { action } : {}) },
      ]),
    offer: (command) => {
      const next = new URLSearchParams(params)
      next.set('command', command)
      setParams(next, { replace: true, state: location.state })
    },
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
      <RoomJobLifecycleNotice
        notice={lifecycleNotice}
        busyJobId={lifecycleBusy}
        onStop={(job) => void stopForLifecycle(job)}
        onDismiss={() => setLifecycleNotice(null)}
      />
      <RoomJobStrip
        roomId={room.id}
        showNextUp={room.role === 'team'}
        agents={agents}
        barJob={barJob}
        stoppedNote={stoppedNote}
        pastPicked={pastPicked}
        menu={barMenu}
        moreOpen={moreOpen}
        onShowMore={showOpenJobs}
        onShowGraph={onShowGraph}
        onStopped={(stopped) =>
          setStoppedNote({
            jobId: stopped.id,
            text: `Stopped “${stopped.title}”. It’s in Past jobs.`,
          })
        }
      />
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
