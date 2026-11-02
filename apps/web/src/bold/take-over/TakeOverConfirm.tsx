import { useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { ApiError, apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { passkeysSupportedHere, signInWithPasskey } from '../../data/passkeys.ts'
import { useSecurityStatus } from '../../routes/settings/settings-queries.ts'
import { securityFailure } from '../security-lock.ts'
import './bold-take-over.css'

/** The words for a failed take-over request. */
function problem(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409 || error.status === 502 || error.status === 503) return error.message
    if (error.status === 401 || error.status === 403 || error.code === 'wrong_password')
      return securityFailure({ code: error.code }, 'take over')
  }
  return securityFailure(error, 'take over')
}

function unlockedNow(until: string | null, serverNow: string | null, receivedAt: number): boolean {
  if (!until) return false
  const left = Date.parse(until) - (serverNow ? Date.parse(serverNow) : receivedAt)
  return left - (Date.now() - receivedAt) > 0
}

/** The inline confirmation before taking over (3.17.0): what it does, then the security password or a passkey. */
export function TakeOverConfirm({
  agentId,
  agentName,
  onCancel,
  onTaken,
}: {
  agentId: string
  agentName: string
  onCancel: () => void
  onTaken: () => void
}) {
  const security = useSecurityStatus()
  const queryClient = useQueryClient()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needPassword, setNeedPassword] = useState(false)
  const unlocked =
    !needPassword &&
    unlockedNow(
      security.data?.unlockedUntil ?? null,
      security.data?.serverNow ?? null,
      security.dataUpdatedAt,
    )

  async function take(withPassword: string | undefined) {
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`agents/${encodeURIComponent(agentId)}/bot-screen/take-over`, {
        method: 'POST',
        headers: { 'Idempotency-Key': newId() },
        body: JSON.stringify(withPassword ? { password: withPassword } : {}),
      })
      await queryClient.invalidateQueries({ queryKey: ['bot-screen', agentId] })
      void queryClient.invalidateQueries({ queryKey: ['session', 'security'] })
      onTaken()
    } catch (caught) {
      setError(problem(caught))
      if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403))
        setNeedPassword(true)
    } finally {
      setBusy(false)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const typed = password
    // The password leaves state as soon as it is sent.
    setPassword('')
    void take(unlocked ? undefined : typed)
  }

  async function unlockWithPasskey() {
    setBusy(true)
    setError(null)
    try {
      await signInWithPasskey()
    } catch (caught) {
      setError(securityFailure(caught, 'use the passkey'))
      setBusy(false)
      return
    }
    setBusy(false)
    await take(undefined)
  }

  return (
    <form
      className="bold-to-confirm"
      data-protected="block"
      aria-labelledby="bold-to-confirm-h"
      onSubmit={submit}
    >
      <h3 id="bold-to-confirm-h">Take over {agentName}’s desktop?</h3>
      <ul>
        <li>
          {agentName}’s screen and browser tools pause until you hand back. Programs it started in
          its terminal keep running.
        </li>
        <li>
          Your clicks and keys go to its desktop. Nobody else sees the screen while you have
          control.
        </li>
        <li>
          Control goes back to {agentName} when you hand back, leave this page, or after 5 minutes
          without input.
        </li>
      </ul>
      {unlocked ? (
        <p className="bold-to-note">
          Remote access and security is unlocked, so Score won’t ask for the password.
        </p>
      ) : (
        <>
          <label htmlFor="bold-to-pw">Security password</label>
          <input
            id="bold-to-pw"
            type="password"
            autoComplete="current-password"
            placeholder="Your Score security password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </>
      )}
      <div className="bold-to-confirm-actions">
        <button
          type="submit"
          className="bold-to-primary"
          disabled={busy || (!unlocked && password === '')}
        >
          {busy ? 'Taking over…' : 'Take over'}
        </button>
        {passkeysSupportedHere() && (
          <button
            type="button"
            className="bold-to-link"
            disabled={busy}
            onClick={() => void unlockWithPasskey()}
          >
            Use a passkey instead
          </button>
        )}
        <button type="button" className="bold-to-link bold-to-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  )
}
