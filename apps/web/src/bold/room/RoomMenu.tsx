import type { Room } from '@score/contract'
import { useId, useRef, useState, type RefObject } from 'react'
import { useStreamQuery } from '../../data/query-client.ts'
import { patchRoom } from '../../routes/chat/conversation-api.ts'
import { setShowDeleted, useShowDeleted } from '../../routes/chat/deleted-toggle.ts'
import { roomsQuery } from '../../routes/chat/queries.ts'
import { TrashIcon } from '../BoldIcons.tsx'
import { useSharedWorkspaces } from '../workspaces-queries.ts'
import { DotsIcon, moveInMenu, useMenu } from './menu-primitives.tsx'
import { useMenuPlacement } from './menu-placement.ts'
import {
  RenameRoomDialog,
  RoomProjectDialog,
  RoomWorkspaceDialog,
  TeamLeadDialog,
} from './RoomDialogs.tsx'
import { isEveryoneRoom } from './room-model.ts'
import { TeamMembersDialog } from './TeamDialogs.tsx'

export function RoomMenu({
  room,
  onShare,
  onDelete,
  onOtherRooms,
  triggerRef,
}: {
  room: Room
  onShare: (room: Room) => void
  onDelete: (room: Room) => void
  /** Desktop: opens the list of older, imported and elsewhere chats (the title no longer has a switcher). */
  onOtherRooms?: () => void
  /** Lets the room switcher return focus to this button when it closes. */
  triggerRef?: RefObject<HTMLButtonElement | null>
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  useMenuPlacement(root, open)
  const ownTrigger = useRef<HTMLButtonElement>(null)
  const trigger = triggerRef ?? ownTrigger
  const menuId = useId()
  const close = useMenu(open, setOpen, root, trigger)
  // `team` = any team room (the lead and members live here); `everyone` = the first one, which can't be changed.
  const team = room.role === 'team'
  const everyone = isEveryoneRoom(room)
  const showDeleted = useShowDeleted(room.id)
  const projects = useStreamQuery(roomsQuery).data?.projects ?? []
  const workspaces = useSharedWorkspaces(open)
  const workspaceName =
    workspaces.data?.find((workspace) => workspace.id === room.workspaceId)?.name ?? null
  const [dialog, setDialog] = useState<
    'rename' | 'project' | 'lead' | 'members' | 'workspace' | null
  >(null)
  const [failure, setFailure] = useState<string | null>(null)
  async function organise(body: { pinned: boolean } | { archived: boolean }, what: string) {
    setFailure(null)
    try {
      await patchRoom(room.id, body)
      close()
    } catch {
      setFailure(`Couldn’t ${what}. Try again.`)
    }
  }
  return (
    <span className="bold-room-menu-wrap" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="icon-btn sm"
        aria-label="Room menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <DotsIcon />
      </button>
      {open && (
        <div
          className="menu bold-room-menu"
          id={menuId}
          role="menu"
          aria-label={`${room.name} actions`}
          data-protected="flex"
          onKeyDown={moveInMenu}
        >
          {onOtherRooms && (
            <button
              type="button"
              className="mi"
              role="menuitem"
              onClick={() => {
                close(false)
                onOtherRooms()
              }}
            >
              Older, imported and elsewhere chats…
            </button>
          )}
          {!everyone && (
            <>
              <button
                type="button"
                className="mi"
                role="menuitem"
                onClick={() => {
                  close(false)
                  setDialog('rename')
                }}
              >
                Rename…
              </button>
              {!team && (
                <button
                  type="button"
                  className="mi"
                  role="menuitem"
                  onClick={() =>
                    void organise(
                      { pinned: !room.pinned },
                      room.pinned ? 'unpin the room' : 'pin the room',
                    )
                  }
                >
                  {room.pinned ? 'Unpin' : 'Pin'}
                </button>
              )}
              <button
                type="button"
                className="mi"
                role="menuitem"
                onClick={() =>
                  void organise(
                    { archived: !room.archived },
                    room.archived ? 'unarchive the room' : 'archive the room',
                  )
                }
              >
                {room.archived ? 'Unarchive' : 'Archive'}
              </button>
              {!team && (
                <button
                  type="button"
                  className="mi"
                  role="menuitem"
                  onClick={() => {
                    close(false)
                    setDialog('project')
                  }}
                >
                  Project…
                </button>
              )}
              {failure && (
                <div className="small bold-menu-note" role="alert">
                  {failure}
                </div>
              )}
            </>
          )}
          <button
            type="button"
            className="mi"
            role="menuitem"
            onClick={() => {
              close(false)
              setDialog('workspace')
            }}
          >
            Workspace: {workspaceName ?? (room.workspaceId ? '…' : 'none')}
          </button>
          <a
            className="mi"
            role="menuitem"
            href={`/api/rooms/${encodeURIComponent(room.id)}/export.md`}
            download
            onClick={() => {
              // Let the browser start the download before the link unmounts, then return focus.
              window.setTimeout(() => close(), 0)
            }}
          >
            Export this room
          </a>
          <a
            className="mi"
            role="menuitem"
            href={`/api/rooms/${encodeURIComponent(room.id)}/export.json`}
            download
            onClick={() => {
              window.setTimeout(() => close(), 0)
            }}
          >
            Export as JSON
          </a>
          <button
            type="button"
            className="mi"
            role="menuitemcheckbox"
            aria-checked={showDeleted}
            onClick={() => {
              close(false)
              setShowDeleted(room.id, !showDeleted)
            }}
          >
            {showDeleted ? 'Hide deleted messages' : 'Show deleted messages'}
          </button>
          <button
            type="button"
            className="mi"
            role="menuitem"
            onClick={() => {
              close(false)
              onShare(room)
            }}
          >
            Share a read-only link
          </button>
          {team && (
            <div className="small muted bold-menu-note">
              Shares the selected job’s thread; under All, the team room’s default thread.
            </div>
          )}
          {team && (
            <button
              type="button"
              className="mi"
              role="menuitem"
              onClick={() => {
                close(false)
                setDialog('lead')
              }}
            >
              Team lead…
            </button>
          )}
          {team && !everyone && (
            <button
              type="button"
              className="mi"
              role="menuitem"
              onClick={() => {
                close(false)
                setDialog('members')
              }}
            >
              Members…
            </button>
          )}
          {everyone ? (
            <div className="small muted bold-menu-note">
              The team room is always on, so it can’t be deleted. Delete jobs inside it instead.
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="mi bad"
              onClick={() => {
                close(false)
                onDelete(room)
              }}
            >
              <TrashIcon />
              Delete {room.name}
            </button>
          )}
        </div>
      )}
      {dialog === 'lead' && (
        <TeamLeadDialog
          room={room}
          onClose={() => {
            setDialog(null)
            trigger.current?.focus()
          }}
        />
      )}
      {dialog === 'members' && (
        <TeamMembersDialog
          room={room}
          onClose={() => {
            setDialog(null)
            trigger.current?.focus()
          }}
        />
      )}
      {dialog === 'rename' && (
        <RenameRoomDialog
          room={room}
          onClose={() => {
            setDialog(null)
            trigger.current?.focus()
          }}
        />
      )}
      {dialog === 'workspace' && (
        <RoomWorkspaceDialog
          room={room}
          onClose={() => {
            setDialog(null)
            trigger.current?.focus()
          }}
        />
      )}
      {dialog === 'project' && (
        <RoomProjectDialog
          room={room}
          projects={projects}
          onClose={() => {
            setDialog(null)
            trigger.current?.focus()
          }}
        />
      )}
    </span>
  )
}
