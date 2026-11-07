import type { Message } from '@score/contract'
import { useEffect, useState } from 'react'
import { StopIcon } from '../../components/StopIcon.tsx'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { approvalsQuery } from './queries.ts'
import { formatElapsed, stalledFor } from './stall.ts'

/** Shown only while stalled: asks the approvals list, because a reply waiting for the person is not stalled. */
function StalledLine({ message, elapsed }: { message: Message; elapsed: number }) {
  const { data } = useStreamQuery(approvalsQuery)
  const runId = message.refs.find((ref) => ref.kind === 'run')?.runId
  const waitingForYou = Boolean(
    runId &&
    data?.some(
      (approval) =>
        approval.status === 'pending' &&
        approval.refs.some((ref) => ref.kind === 'run' && ref.runId === runId),
    ),
  )
  if (waitingForYou) return null
  return (
    <span className="chat-stalled" role="status">
      Waiting for the model ({formatElapsed(elapsed)}). Hermes may be retrying after a rate limit or
      a provider error.
    </span>
  )
}

function useNow(every: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(timer)
  }, [every])
  return now
}

export function StopReply({ message, name }: { message: Message; name: string }) {
  const now = useNow(5_000)
  const elapsed = stalledFor(message, now)
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')
  async function stop() {
    setState('busy')
    try {
      await apiFetch(
        `rooms/${encodeURIComponent(message.roomId)}/messages/${encodeURIComponent(message.id)}/stop`,
        { method: 'POST', headers: { 'Idempotency-Key': newId() }, body: '{}' },
      )
      setState('idle')
    } catch {
      setState('failed')
    }
  }
  return (
    <div className="chat-stop-row">
      {elapsed !== null && <StalledLine message={message} elapsed={elapsed} />}
      <button
        type="button"
        className="chat-stop-reply"
        data-protected="inline-flex"
        aria-label={
          state === 'busy' ? `Stopping the reply from ${name}` : `Stop reply from ${name}`
        }
        title="Stop"
        aria-busy={state === 'busy'}
        disabled={state === 'busy'}
        onClick={() => void stop()}
      >
        <StopIcon />
      </button>
      {state === 'failed' && (
        <span className="chat-action-error" role="alert">
          Couldn’t stop it. It may have just finished.
        </span>
      )}
    </div>
  )
}
