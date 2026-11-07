import type { AgentSummary } from '@score/contract'
import type { Editing } from './message-edit.ts'
import { RewindDialog } from './RewindDialog.tsx'

export function ComposerEditing({
  editing,
  confirmEdit,
  roomId,
  roomMode,
  agents,
  rewinding,
  onClose,
  onDone,
  onCancel,
}: {
  editing: Editing | null
  confirmEdit: boolean
  roomId: string
  roomMode: boolean
  agents: AgentSummary[]
  rewinding: boolean
  onClose: () => void
  onDone: (messageId: string) => void
  onCancel: () => void
}) {
  return (
    <>
      {editing && confirmEdit && (
        <RewindDialog
          roomId={roomId}
          messageId={editing.messageId}
          mode="edit"
          agents={agents}
          onClose={onClose}
          onDone={() => onDone(editing.messageId)}
        />
      )}
      {editing && (
        <div className="chat-editing" role="status">
          <span>Editing your message</span>
          <span className="chat-edit-note">
            {roomMode
              ? 'Sending replaces it and rewinds the agents to before it (long-term memory stays).'
              : 'Sending hides it and everything after it as the previous version.'}
          </span>
          <button
            type="button"
            className="chat-editing-cancel"
            onClick={onCancel}
            // While Send rewinds, Cancel can't take it back (the correction's post can still be left, as before).
            disabled={rewinding}
          >
            Cancel
          </button>
        </div>
      )}
    </>
  )
}
