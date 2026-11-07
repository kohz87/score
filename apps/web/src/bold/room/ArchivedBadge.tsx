import type { Room } from '@score/contract'
import { useState } from 'react'
import { patchRoom } from '../../routes/chat/conversation-api.ts'
import { isEveryoneRoom } from './room-model.ts'

/** Shown beside the title while the open room is archived, with the way back right there. */
export function ArchivedBadge({ room }: { room: Room | null }) {
  const [failed, setFailed] = useState(false)
  if (!room?.archived || isEveryoneRoom(room)) return null
  return (
    <span className="bold-room-archived">
      <span className="bold-room-kind-badge">Archived</span>
      <button
        type="button"
        className="link"
        onClick={() => {
          setFailed(false)
          patchRoom(room.id, { archived: false }).catch(() => setFailed(true))
        }}
      >
        Unarchive
      </button>
      {failed && (
        <span className="small" role="alert">
          Couldn’t unarchive. Try again.
        </span>
      )}
    </span>
  )
}
