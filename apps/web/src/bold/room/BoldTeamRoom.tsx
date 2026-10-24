import type { AgentSummary, Room } from '@score/contract'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { useStreamQuery } from '../../data/query-client.ts'
import { useShowDeleted, setShowDeleted } from '../../routes/chat/deleted-toggle.ts'
import '../../routes/chat/chat.css'
import { Composer } from '../../routes/chat/Composer.tsx'
import { saveDraft } from '../../routes/chat/composer-model.ts'
import { ChevronIcon } from '../BoldIcons.tsx'
import { RoomCapsules } from './RoomCapsules.tsx'
import { RoomEmpty } from './RoomEmpty.tsx'
import { RoomMessageStream } from './RoomMessageStream.tsx'
import { RoomRequests } from './RoomRequests.tsx'
import { RoomTabs } from './RoomTabs.tsx'
import { jobMatchesFilter, type JobFilter } from './room-model.ts'
import { roomJobsQuery, roomMessagesQuery, teamRoomQuery } from './room-queries.ts'
import './bold-room.css'

function RoomTitle({ name, action }: { name: string; action?: ReactNode }) {
  return (
    <div className="roomhead">
      <button className="roomtitle" type="button">
        {name}
        <ChevronIcon />
      </button>
      {action}
    </div>
  )
}

function RoomWaiting({ name, action }: { name: string; action?: ReactNode }) {
  return (
    <>
      <RoomTitle name={name} action={action} />
      <p className="bold-stream-note" role="status">
        Loading the team room…
      </p>
    </>
  )
}

function RoomUnavailable({
  name,
  action,
  error,
}: {
  name: string
  action?: ReactNode
  error: boolean
}) {
  return (
    <>
      <RoomTitle name={name} action={action} />
      <div className="bold-room-unavailable" role={error ? 'alert' : 'status'}>
        <b>{error ? 'Couldn’t open the team room.' : 'The team room isn’t ready yet.'}</b>
        <span>
          {error
            ? 'Check that Score is running, then try again.'
            : 'It appears once the team’s agents are known.'}
        </span>
      </div>
    </>
  )
}

function LoadedTeamRoom({
  room,
  agents,
  phoneAction,
}: {
  room: Room
  agents: AgentSummary[]
  phoneAction?: ReactNode
}) {
  const [params, setParams] = useSearchParams()
  const jobsDefinition = useMemo(() => roomJobsQuery(room.id), [room.id])
  const { data: jobs, status: jobsStatus } = useStreamQuery(jobsDefinition)
  const allJobs = useMemo(() => jobs ?? [], [jobs])
  const defaultJobId = allJobs.find((job) => job.isDefault)?.id ?? null
  const jobIds = useMemo(() => allJobs.map((job) => job.id), [allJobs])
  const messagesDefinition = useMemo(
    () => roomMessagesQuery(room.id, jobIds, defaultJobId),
    [defaultJobId, jobIds, room.id],
  )
  const { data: messages, status: messagesStatus } = useStreamQuery(messagesDefinition)
  const [filter, setFilter] = useState<JobFilter>('all')
  const [composerKey, setComposerKey] = useState(0)
  const showDeleted = useShowDeleted(room.id)
  const selectedJob = params.get('job') ?? 'all'
  const seek = params.get('message')
  const command = params.get('command')

  const selectJob = useCallback(
    (jobId: string) => {
      const next = new URLSearchParams(params)
      if (jobId === 'all') next.delete('job')
      else next.set('job', jobId)
      next.delete('message')
      setParams(next, { replace: true })
    },
    [params, setParams],
  )

  useEffect(() => {
    if (jobsStatus !== 'success' || selectedJob === 'all') return
    if (allJobs.some((job) => job.id === selectedJob)) return
    selectJob('all')
  }, [allJobs, jobsStatus, selectJob, selectedJob])

  useEffect(() => {
    if (selectedJob === 'all') return
    const job = allJobs.find((item) => item.id === selectedJob)
    if (job && !jobMatchesFilter(job, filter)) selectJob('all')
  }, [allJobs, filter, selectJob, selectedJob])

  const namedJobs = allJobs.filter((job) => !job.isDefault)
  const empty =
    jobsStatus === 'success' &&
    namedJobs.length === 0 &&
    messagesStatus === 'success' &&
    (messages?.items.length ?? 0) === 0
  const job = allJobs.find((item) => item.id === selectedJob)
  const toLabel = job ? `To: ${job.title}` : 'To: new job'

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
      <RoomTitle name={room.name} action={phoneAction} />
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
          onSelectFilter={setFilter}
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
          jobs={allJobs}
          agents={agents}
          messages={messages?.items ?? []}
          selectedJob={selectedJob}
        />
      )}
      {empty ? (
        <RoomEmpty agents={agents} onStart={startWith} />
      ) : (
        <div className="stream" id="bold-room-stream" aria-live="polite">
          <RoomCapsules jobs={allJobs} agents={agents} selectedJob={selectedJob} filter={filter} />
          <RoomMessageStream
            roomId={room.id}
            jobs={allJobs}
            agents={agents}
            selectedJob={selectedJob}
            filter={filter}
            showDeleted={showDeleted}
            seek={seek}
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
          messagesKey={messagesDefinition.key}
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
}: {
  agents: AgentSummary[]
  phoneAction?: ReactNode
}) {
  const [params] = useSearchParams()
  const override = params.get('room')
  const definition = useMemo(() => teamRoomQuery(override), [override])
  const { data: room, status } = useStreamQuery(definition)

  if (status === 'pending') return <RoomWaiting name="Team room" action={phoneAction} />
  if (status === 'error' || !room)
    return <RoomUnavailable name="Team room" action={phoneAction} error={status === 'error'} />
  return <LoadedTeamRoom room={room} agents={agents} phoneAction={phoneAction} />
}
