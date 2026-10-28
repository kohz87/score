import { useId, useState, type FormEvent } from 'react'
import { SecurityUnlockSchema } from '@score/contract'
import { apiFetch } from '../data/api.ts'
import { securityFailure, useRefreshSecurity } from './security-lock.ts'

function LockIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

/** The light card that stands in for the whole section until the security password opens it (3.14.2). */
export function SecurityLockCard() {
  const refresh = useRefreshSecurity()
  const field = useId()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function unlock(event: FormEvent) {
    event.preventDefault()
    const typed = password
    // The password is not kept in state a moment longer than the request needs.
    setPassword('')
    setBusy(true)
    setError('')
    try {
      SecurityUnlockSchema.parse(
        await apiFetch('session/security/unlock', {
          method: 'POST',
          body: JSON.stringify({ password: typed }),
        }),
      )
    } catch (caught) {
      setError(securityFailure(caught, 'unlock this section'))
      setBusy(false)
      return
    }
    // Unlocked: a slow or failed status read is not an unlock failure (review).
    await refresh().catch(() => undefined)
    setBusy(false)
  }
  return (
    <section className="bold-security-lock" data-protected="flex" aria-labelledby="security-lock-h">
      <span className="bold-security-lock-icon" aria-hidden="true">
        <LockIcon />
      </span>
      <h2 id="security-lock-h">This section is locked</h2>
      <p className="bold-security-lock-text">
        Paired devices, pairing links, passkeys, the terminal and the password itself decide who can
        control Score. Enter your security password to open them.
      </p>
      <form onSubmit={(event) => void unlock(event)}>
        <label htmlFor={field}>Security password</label>
        <span className="bold-security-lock-row">
          <input
            id={field}
            type="password"
            autoComplete="current-password"
            placeholder="Your security password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button type="submit" disabled={busy || password.length === 0}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
        </span>
        {error && <p role="alert">{error}</p>}
      </form>
      <p className="bold-security-lock-note">
        It locks again after 5 minutes without use, when you leave this page, or with Lock now.
        Forgot it? Run <code>scripts/score password</code> on the Score machine.
      </p>
    </section>
  )
}

/** Nothing here works until a security password exists, so it is the only thing shown (3.14.2). */
export function SecurityFirstRun() {
  const refresh = useRefreshSecurity()
  const first = useId()
  const second = useId()
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function save(event: FormEvent) {
    event.preventDefault()
    if (next !== again) {
      setError('The two passwords don’t match.')
      return
    }
    const typed = next
    setNext('')
    setAgain('')
    setBusy(true)
    setError('')
    try {
      await apiFetch('session/security/password', {
        method: 'PUT',
        body: JSON.stringify({ password: typed }),
      })
    } catch (caught) {
      setError(securityFailure(caught, 'save the password'))
      setBusy(false)
      return
    }
    // The server unlocked this session by setting the first password.
    await refresh().catch(() => undefined)
    setBusy(false)
  }
  return (
    <section
      className="bold-security-first"
      data-protected="flex"
      aria-labelledby="security-first-h"
    >
      <h2 id="security-first-h">Set a security password first</h2>
      <p className="bold-security-lock-text">
        It locks this section, and pairing, ending pairings and passkeys need it, so a lost phone
        can’t invite others or lock you out. Until it is set, nothing here can be changed.
      </p>
      <form aria-label="Set a security password" onSubmit={(event) => void save(event)}>
        <label htmlFor={first}>
          New password (at least 8 characters)
          <input
            id={first}
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={256}
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
        </label>
        <label htmlFor={second}>
          The same password again
          <input
            id={second}
            type="password"
            autoComplete="new-password"
            required
            value={again}
            onChange={(event) => setAgain(event.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Set password and open'}
        </button>
      </form>
      <p className="bold-security-lock-note">
        If you forget it, reset it on the Score machine with <code>scripts/score password</code>.
      </p>
    </section>
  )
}
