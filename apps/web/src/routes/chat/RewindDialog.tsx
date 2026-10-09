import type { AgentSummary, RewindMode, RewindSkipReason } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { fetchRewindPlan, postRewind, REASON_TEXT } from './rewind.ts'

type Failure = { agentId: string; reason: RewindSkipReason }[]

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * Confirmation before an edit or a delete of your own message (PLAN 5.33): says what is hidden, which agents are
 * rewound by how many turns, what is not rewound, and offers "Hide in Score only" when an agent cannot be rewound.
 */
export function RewindDialog({
  roomId,
  messageId,
  mode,
  agents,
  onDone,
  onClose,
}: {
  roomId: string
  messageId: string
  mode: RewindMode
  agents: AgentSummary[]
  onDone: () => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const plan = useQuery({
    queryKey: ['chat', 'rewind-plan', roomId, messageId],
    queryFn: () => fetchRewindPlan(roomId, messageId),
    gcTime: 0,
    staleTime: 0,
    retry: false,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failed, setFailed] = useState<Failure | null>(null)
  const keys = useRef({ rewind: newId(), scoreOnly: newId() })
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  const name = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id

  async function confirm(scoreOnly: boolean) {
    setBusy(true)
    setError(null)
    try {
      await postRewind(
        roomId,
        messageId,
        mode,
        scoreOnly,
        scoreOnly ? keys.current.scoreOnly : keys.current.rewind,
      )
      onDone()
    } catch (caught) {
      setBusy(false)
      if (caught instanceof ApiError && caught.code === 'rewind_incomplete') {
        const details = caught.details as { skipped?: Failure } | undefined
        setFailed(details?.skipped ?? [])
        // A new attempt (after the failure) is a new request.
        keys.current.rewind = newId()
      } else
        setError(
          caught instanceof ApiError && caught.status === 409
            ? caught.message
            : 'Could not do that. Please try again.',
        )
    }
  }

  const data = plan.data
  const cannot = failed ?? data?.agents.flatMap((a) => (a.cannot ? [{ agentId: a.agentId, reason: a.cannot }] : []))
  const rewinds = data?.agents.filter((agent) => agent.turns > 0 && !agent.cannot) ?? []
  const title = mode === 'edit' ? 'Edit and send again?' : 'Delete this message?'
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="chat-rewind-dialog"
      aria-labelledby="rewind-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id="rewind-title">{title}</h2>
      {plan.isPending && <p role="status">Checking what this changes…</p>}
      {plan.isError && (
        <p role="alert">Could not check what this changes. Close this and try again.</p>
      )}
      {data && (
        <>
          <ul className="chat-rewind-list">
            <li>
              {plural(data.hiddenCount, 'message', 'messages')} (this one and everything after it)
              will be hidden as the previous version. You can still look at it.
            </li>
            {rewinds.length > 0 && (
              <li>
                Agents rewound:{' '}
                {rewinds
                  .map((agent) => `${name(agent.agentId)} −${plural(agent.turns, 'turn', 'turns')}`)
                  .join(', ')}
                .
              </li>
            )}
            {rewinds.length === 0 && !cannot?.length && (
              <li>No agent has a turn to rewind from here.</li>
            )}
            <li>
              Long-term memory (MEMORY.md, skills, Knowledge notes) is not rewound.
            </li>
          </ul>
          {data.blocked && (
            <p className="chat-rewind-warning" role="alert">
              {data.blocked}.
            </p>
          )}
          {cannot && cannot.length > 0 && (
            <div className="chat-rewind-warning" role="alert">
              <p>
                {failed ? 'Nothing was hidden. ' : ''}These agents cannot be rewound:
              </p>
              <ul>
                {cannot.map((item) => (
                  <li key={item.agentId}>
                    {name(item.agentId)}: {REASON_TEXT[item.reason]}
                  </li>
                ))}
              </ul>
              <p>You can hide it in Score only; those agents will still remember it.</p>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="chat-rewind-warning" role="alert">
          {error}
        </p>
      )}
      <div className="chat-rewind-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        {cannot && cannot.length > 0 && (
          <button type="button" disabled={busy || !data} onClick={() => void confirm(true)}>
            Hide in Score only
          </button>
        )}
        <button
          type="button"
          className="chat-rewind-primary"
          disabled={busy || !data || Boolean(data.blocked) || Boolean(cannot?.length)}
          onClick={() => void confirm(false)}
        >
          {busy ? 'Working…' : mode === 'edit' ? 'Rewind and edit' : 'Rewind and delete'}
        </button>
      </div>
    </dialog>
  )
}
