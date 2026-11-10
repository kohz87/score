// Tasks › Repeating (TR.2): the three notes that ask the person to decide something, so each is a protected surface:
// the move note (mock-up 28-tasks-edit), "still has it" after a move that couldn't remove the old job, and Delete.

export function MoveNote({ from, to }: { from: string; to: string }) {
  return (
    <div className="bold-rj-note" role="alert" data-protected="block">
      <b>Moving it to {to}?</b>
      <span>
        Score creates the job for {to} and then removes {from}’s. {from}’s past runs stay in {from}
        ’s history. If one step fails, nothing is lost: the card says which agent has it.
      </span>
    </div>
  )
}

export function LeftBehindNote({
  agent,
  busy,
  onRemove,
}: {
  agent: string
  busy: boolean
  onRemove: () => void
}) {
  return (
    <div className="bold-rj-note" role="alert" data-protected="block">
      <span>{agent} still has it: Hermes didn’t remove it. Remove it there or try again.</span>
      <button type="button" disabled={busy} onClick={onRemove}>
        Remove
      </button>
    </div>
  )
}

export function DeleteConfirm({
  title,
  agent,
  busy,
  onKeep,
  onDelete,
}: {
  title: string
  agent: string
  busy: boolean
  onKeep: () => void
  onDelete: () => void
}) {
  return (
    <div className="bold-rj-note" role="alert" data-protected="block">
      <b>Delete “{title}”?</b>
      <span>
        It stops repeating and is removed from {agent}. Its past runs stay in {agent}’s history.
      </span>
      <span className="bold-rj-note-actions">
        <button type="button" disabled={busy} onClick={onDelete}>
          Delete it
        </button>
        <button type="button" onClick={onKeep}>
          Keep it
        </button>
      </span>
    </div>
  )
}
