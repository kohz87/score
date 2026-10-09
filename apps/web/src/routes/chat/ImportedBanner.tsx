import type { AgentSummary, Room } from '@score/contract'
import { useState } from 'react'
import { ApiError } from '../../data/api.ts'
import { useContinueSession } from '../../data/outside-sessions.ts'

/** Top of an imported room: what it is, and "Continue here" (PLAN 5.26). */
export function ImportedBanner({ room, agents }: { room: Room; agents: AgentSummary[] }) {
  const from = room.importedFrom!
  const agent = agents.find((item) => item.id === from.agentId)?.name ?? from.agentId
  const proceed = useContinueSession(room.id)
  const [chosen, setChosen] = useState<typeof from.continued>(null)
  const mode = chosen ?? from.continued
  const error =
    proceed.error instanceof ApiError
      ? proceed.error.status === 409 && proceed.error.code === 'session_busy'
        ? proceed.error.message
        : proceed.error.status === 404
          ? 'That session is no longer in Hermes.'
          : 'Could not continue the session. Please try again.'
      : proceed.error
        ? 'Could not continue the session. Please try again.'
        : null
  return (
    <div className="chat-imported" role="region" aria-label="Imported conversation">
      <p>
        <strong>Imported from {from.label}.</strong> These are read-only copies of {agent}&apos;s
        messages; Hermes was not changed.
      </p>
      {mode === 'same_session' && (
        <p role="status">
          New messages in this room go into the same Hermes session, so {agent} remembers the whole
          conversation.
        </p>
      )}
      {mode === 'new_session' && (
        <p role="status">
          This session cannot be reopened. New messages start a new Hermes session that begins with
          a short summary of the imported conversation.
        </p>
      )}
      {mode === null && (
        <button
          type="button"
          className="chat-small-button"
          disabled={proceed.isPending}
          onClick={() =>
            proceed.mutate(undefined, { onSuccess: (result) => setChosen(result.mode) })
          }
        >
          {proceed.isPending ? 'Checking…' : 'Continue here'}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
