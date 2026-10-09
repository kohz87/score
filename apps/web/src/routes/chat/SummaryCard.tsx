import type { Message, MessagePart } from '@score/contract'
import { useState } from 'react'
import { ApiError } from '../../data/api.ts'
import { deleteSummary, editSummary, regenerateSummary } from './conversation-api.ts'
import { Markdown } from './Markdown.tsx'

type SummaryPart = Extract<MessagePart, { kind: 'summary' }>

/**
 * The room's summary of earlier messages (PLAN 7.4a). It is agent output that becomes context for every later turn, so
 * it is shown in full, labelled with the agent that wrote it, editable, and says when it is no longer being used.
 */
export function SummaryCard({
  part,
  message,
  authorName,
  readOnly,
}: {
  part: SummaryPart
  message: Message
  authorName: string
  readOnly: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(part.text)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  async function run(action: () => Promise<unknown>, done?: () => void) {
    setBusy(true)
    setError(null)
    try {
      await action()
      done?.()
    } catch (failure) {
      setError(
        failure instanceof ApiError ? failure.message : 'Could not do that. Please try again.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="chat-card chat-summary" aria-label="Summary of earlier messages">
      <header className="chat-summary-head">
        <strong>Summary of earlier messages</strong>
        <span className="chat-summary-by">written by {authorName}</span>
        {part.edited && <span className="chat-summary-badge">edited by you</span>}
        {part.stale && (
          <span className="chat-summary-badge chat-summary-badge--stale">
            out of date: not used as context
          </span>
        )}
      </header>
      {part.stale && (
        <p className="chat-summary-note">
          A message it covers was edited, deleted or rewound. Agents get the recent messages instead
          until you regenerate this summary or edit it yourself.
        </p>
      )}
      {editing ? (
        <form
          className="chat-summary-edit"
          onSubmit={(event) => {
            event.preventDefault()
            void run(
              () => editSummary(message.roomId, draft),
              () => setEditing(false),
            )
          }}
        >
          <label>
            Summary text
            <textarea
              value={draft}
              maxLength={16384}
              rows={8}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <div className="chat-summary-actions">
            <button type="submit" disabled={busy || !draft.trim()}>
              Save
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="chat-summary-text">
          <Markdown text={part.text} />
        </div>
      )}
      {!readOnly && !editing && (
        <div className="chat-summary-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(part.text)
              setEditing(true)
            }}
          >
            Edit
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => regenerateSummary(message.roomId))}
          >
            Regenerate
          </button>
          {confirming ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => deleteSummary(message.roomId),
                    () => setConfirming(false),
                  )
                }
              >
                Delete summary
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={() => setConfirming(true)}>
              Delete
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="chat-action-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
