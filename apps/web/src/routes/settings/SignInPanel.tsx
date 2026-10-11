import { useEffect, useRef, useState } from 'react'
import type { ConnectResult } from '@score/contract'
import { copyText, selectText } from '../../data/clipboard.ts'
import { cancelSignIn, useSignIn } from './settings-queries.ts'

// Device-code sign-in (ARCHITECTURE D2.7): the link and code come from Hermes through the server. Approving signs in
// the machine Hermes runs on, so only this short-lived code crosses the network.
export function SignInPanel({
  label,
  start,
  onConnected,
  onClose,
  onTerminal,
  onRetry,
}: {
  label: string
  start: ConnectResult
  onConnected: () => void
  onClose: () => void
  onTerminal: () => void
  onRetry: () => void
}) {
  const signInId = start.signInId!
  const poll = useSignIn(signInId)
  const [copy, setCopy] = useState<'idle' | 'copied' | 'manual'>('idle')
  const [cancelling, setCancelling] = useState(false)
  const code = useRef<HTMLElement>(null)
  const state = poll.data?.state ?? 'waiting'
  const url = poll.data ? poll.data.url : (start.url ?? null)
  const codeText = poll.data ? poll.data.code : (start.code ?? null)
  const notified = useRef(false)
  useEffect(() => {
    if (state === 'connected' && !notified.current) {
      notified.current = true
      onConnected()
    }
  }, [state, onConnected])

  async function copyCode() {
    if (!codeText) return
    if (await copyText(codeText)) setCopy('copied')
    else {
      selectText(code.current)
      setCopy('manual')
    }
  }
  async function cancel() {
    setCancelling(true)
    try {
      if (state === 'waiting') await cancelSignIn(signInId)
    } catch {
      // The sign-in is gone or already over; closing is still right.
    }
    onClose()
  }

  const failed = state === 'failed' || state === 'expired' || state === 'cancelled'
  return (
    <div className="settings-signin" role="group" aria-label={`Sign in to ${label}`}>
      {state === 'waiting' && url && codeText && (
        <>
          <p>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="settings-signin-link"
            >
              Open the sign-in page
            </a>{' '}
            and enter this code. You can do it on any device.
          </p>
          <div className="settings-signin-code-row">
            <code ref={code} className="settings-signin-code" aria-label="Sign-in code">
              {codeText}
            </code>
            <button type="button" className="settings-pill" onClick={() => void copyCode()}>
              {copy === 'copied' ? 'Copied' : 'Copy code'}
            </button>
          </div>
          {copy === 'manual' && (
            <p role="status">The code is selected: press Ctrl+C (or ⌘C) to copy it.</p>
          )}
          <p className="settings-muted" role="status">
            Waiting for you to approve…
          </p>
        </>
      )}
      {state === 'connected' && <p role="status">{label} is connected.</p>}
      {failed && (
        <p role="alert">
          {state === 'cancelled'
            ? 'Sign-in cancelled.'
            : (poll.data?.message ?? 'The sign-in did not finish.')}
        </p>
      )}
      {poll.isError && state === 'waiting' && (
        <p role="alert">Couldn’t check the sign-in. It may have ended; try again.</p>
      )}
      <div className="settings-command-actions">
        {state === 'waiting' && (
          <button
            type="button"
            className="settings-link"
            disabled={cancelling}
            onClick={() => void cancel()}
          >
            Cancel
          </button>
        )}
        {(failed || poll.isError) && (
          <button type="button" className="settings-pill" onClick={onRetry}>
            Try again
          </button>
        )}
        {state === 'connected' && (
          <button type="button" className="settings-link" onClick={onClose}>
            Done
          </button>
        )}
        {state !== 'connected' && (
          <button type="button" className="settings-link" onClick={onTerminal}>
            Use a terminal instead
          </button>
        )}
      </div>
    </div>
  )
}
