import type { AgentSummary, Job, OutsideSession, Room } from '@score/contract'
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useSearchParams } from 'react-router'
import { useStreamQuery } from '../../data/query-client.ts'
import { DeleteRoomDialog } from '../../routes/chat/DeleteRoomDialog.tsx'
import { ShareDialog } from '../../routes/chat/ShareDialog.tsx'
import { roomsQuery } from '../../routes/chat/queries.ts'
import '../../routes/chat/chat.css'
import { LoadedTeamRoom } from './LoadedTeamRoom.tsx'
import { RoomUnavailable, RoomWaiting } from './RoomEntryStates.tsx'
import { RoomTitle } from './RoomMenus.tsx'
import { isEveryoneRoom } from './room-model.ts'
import { roomJobsQuery, teamRoomQuery, teamRoomsQuery } from './room-queries.ts'
import './bold-room.css'

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
