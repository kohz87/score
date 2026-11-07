import type { AgentSummary, Job, OutsideSession, Room } from '@score/contract'
import { useRef, useState, type ReactNode, type RefObject } from 'react'
import { ChatPhoneBar } from '../chats/ChatHeader.tsx'
import { ArchivedBadge } from './ArchivedBadge.tsx'
import { RoomMenu } from './RoomMenu.tsx'
import { RoomSwitcher } from './RoomSwitcher.tsx'
import { isOlderRoom } from './room-menu-model.ts'

export function RoomTitle({
  current,
  teamRoom,
  teamJobCount,
  rooms,
  agents,
  phone = false,
  phoneJob,
  onBackToChats,
  onChatInfo,
  infoRef,
  infoExpanded,
  chatMeta,
  chatAction,
  onSelectRoom,
  onOpenElsewhere,
  onShare,
  onDelete,
}: {
  current: Room | null
  teamRoom: Room | null
  teamJobCount: number | null
  rooms: Room[]
  agents: AgentSummary[]
  /** The phone room's board 18/03 head, instead of the desktop title. */
  phone?: boolean
  /** The job whose full-screen chat is open; absent means the job list. */
  phoneJob?: Job
  /** 3.21.0 phone: the chat bar's Back (to the chat list), its Info button and that button's ref. */
  onBackToChats?: () => void
  onChatInfo?: () => void
  infoRef?: RefObject<HTMLButtonElement | null>
  infoExpanded?: boolean
  /** 3.21.0 desktop: the owner line under the name, and Chat info after the menus. */
  chatMeta?: (room: Room) => ReactNode
  chatAction?: (room: Room) => ReactNode
  onSelectRoom: (room: Room) => void
  onOpenElsewhere: (session: OutsideSession) => void
  onShare: (room: Room) => void
  onDelete: (room: Room) => void
}) {
  const [otherRooms, setOtherRooms] = useState(false)
  const roomMenuButton = useRef<HTMLButtonElement>(null)
  if (phone && current) {
    return (
      <ChatPhoneBar
        room={current}
        agents={agents}
        job={phoneJob && !phoneJob.isDefault ? phoneJob : undefined}
        infoRef={infoRef}
        infoExpanded={infoExpanded}
        onBack={() => onBackToChats?.()}
        onInfo={() => onChatInfo?.()}
        menu={
          <span className="bold-chat-phone-menu">
            <RoomMenu
              room={current}
              onShare={onShare}
              onDelete={onDelete}
              onOtherRooms={() => setOtherRooms(true)}
              triggerRef={roomMenuButton}
            />
            {/* No title caret on a phone either: the ⋯ menu's "Older, imported and elsewhere chats…" opens this list. */}
            <RoomSwitcher
              current={current}
              teamRoom={teamRoom}
              teamJobCount={teamJobCount}
              rooms={rooms}
              agents={agents}
              onSelectRoom={onSelectRoom}
              onOpenElsewhere={onOpenElsewhere}
              controlled={{ open: otherRooms, setOpen: setOtherRooms, returnTo: roomMenuButton }}
            />
          </span>
        }
        badge={<ArchivedBadge room={current} />}
      />
    )
  }
  return (
    <div className="roomhead bold-chat-bar">
      <div className="bold-chat-bar-id">
        <div className="bold-chat-bar-name">
          <h1 className="roomtitle bold-chat-title">
            {current?.name ?? 'Team room'}
            {current && isOlderRoom(current) && <span className="bold-room-kind">Older room</span>}
          </h1>
          <RoomSwitcher
            current={current}
            teamRoom={teamRoom}
            teamJobCount={teamJobCount}
            rooms={rooms}
            agents={agents}
            onSelectRoom={onSelectRoom}
            onOpenElsewhere={onOpenElsewhere}
            controlled={{ open: otherRooms, setOpen: setOtherRooms, returnTo: roomMenuButton }}
          />
          <ArchivedBadge room={current} />
        </div>
        {current && chatMeta?.(current)}
      </div>
      <span className="bold-room-grow" aria-hidden="true" />
      {current && (
        <RoomMenu
          room={current}
          onShare={onShare}
          onDelete={onDelete}
          onOtherRooms={() => setOtherRooms(true)}
          triggerRef={roomMenuButton}
        />
      )}
      {current && chatAction?.(current)}
    </div>
  )
}
