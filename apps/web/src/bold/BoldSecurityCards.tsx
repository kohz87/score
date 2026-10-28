import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  PairedBrowserSchema,
  PairedBrowsersSchema,
  PairingLinkSchema,
  RevokeOthersResponseSchema,
  type PairedBrowser,
} from '@score/contract'
import { apiFetch } from '../data/api.ts'
import { copyText, selectText } from '../data/clipboard.ts'
import { QrCode } from '../components/QrCode.tsx'
import { announceLogout } from '../data/session.ts'
import { browsersKey, securityFailure, useOnLocked, useRefreshSecurity } from './security-lock.ts'

/** "LAN" for a local address, "ts.net" for a Tailscale name, else the host itself. */
export function originLabel(origin: string): string {
  const host = new URL(origin).hostname
  if (host.endsWith('.ts.net')) return 'ts.net'
  if (/^(?:\d+\.){3}\d+$/.test(host) || host.endsWith('.local') || host === 'localhost')
    return 'LAN'
  return host
}

/** A script client (curl, a Python script…) rather than a person's browser. */
export function looksLikeScript(label: string): boolean {
  return /^(curl|wget|python|node|go-http|httpie|okhttp)\b/i.test(label.trim())
}

function useBrowsers() {
  const onLocked = useOnLocked()
  return useQuery({
    queryKey: browsersKey,
    queryFn: async () => {
      try {
        return PairedBrowsersSchema.parse(await apiFetch('session/browsers')).items
      } catch (error) {
        onLocked(error)
        throw error
      }
    },
  })
}

const post = (path: string, body: unknown = {}) =>
  apiFetch(path, { method: 'POST', body: JSON.stringify(body) })

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' })

function deviceMeta(browser: PairedBrowser): string {
  const seen = new Date(browser.lastSeenAt).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${browser.address} · last seen ${seen} · access until ${shortDate(browser.expiresAt)}`
}

export function DevicesCard() {
  const browsers = useBrowsers()
  const onLocked = useOnLocked()
  const refreshSecurity = useRefreshSecurity()
  const [notice, setNotice] = useState('')
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const done = (message: string) => {
    setNotice(message)
    void browsers.refetch()
    return refreshSecurity()
  }
  const renew = useMutation({
    mutationFn: async (id: string) =>
      PairedBrowserSchema.parse(await post(`session/browsers/${id}/renew`)),
    onSuccess: () => done('Pairing renewed.'),
    onError: onLocked,
  })
  const revoke = useMutation({
    mutationFn: (id: string) => post(`session/browsers/${id}/revoke`),
    onSuccess: () => done('Pairing ended.'),
    onError: onLocked,
  })
  const revokeOthers = useMutation({
    mutationFn: async () =>
      RevokeOthersResponseSchema.parse(await post('session/browsers/revoke-others')),
    onSuccess: ({ revoked }) =>
      done(revoked === 1 ? 'Ended 1 other device.' : `Ended ${revoked} other devices.`),
    onError: onLocked,
  })
  const busy = renew.isPending || revoke.isPending || revokeOthers.isPending
  const error =
    (renew.error ? securityFailure(renew.error, 'renew the pairing') : '') ||
    (revoke.error ? securityFailure(revoke.error, 'end the pairing') : '') ||
    (revokeOthers.error ? securityFailure(revokeOthers.error, 'end the pairings') : '') ||
    ''
  const items = browsers.data ?? []
  return (
    <section className="bold-security-card span-all" aria-labelledby="security-devices">
      <span className="bold-security-card-head">
        <h3 id="security-devices">Paired devices</h3>
        <span className="small muted">They can read every conversation and control Score.</span>
      </span>
      {browsers.isSuccess && items.length === 0 && (
        <p className="small muted">No browser is paired for remote access yet.</p>
      )}
      <ul aria-label="Paired browsers" className="bold-security-rows">
        {items.map((browser) => {
          const label = browser.label.slice(0, 60)
          return (
            <li key={browser.id} className="bold-security-device">
              <span className="bold-security-device-text">
                <b>
                  {label}{' '}
                  {browser.current && <span className="bold-security-tag ok">this one</span>}
                  {looksLikeScript(browser.label) && (
                    <span className="bold-security-tag warn">not a browser</span>
                  )}
                </b>
                <span className="small muted">{deviceMeta(browser)}</span>
              </span>
              <span className="bold-security-device-actions">
                <button
                  type="button"
                  className="bold-security-btn"
                  aria-label={`Renew ${browser.current ? 'this browser' : label}`}
                  disabled={busy}
                  onClick={() => renew.mutate(browser.id)}
                >
                  Renew
                </button>
                {!browser.current && (
                  <button
                    type="button"
                    className="bold-security-btn solid"
                    aria-label={`End ${label}`}
                    disabled={busy}
                    onClick={() => revoke.mutate(browser.id)}
                  >
                    End
                  </button>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      <span className="bold-security-actions">
        {items.length > 1 && (
          <button
            type="button"
            className="bold-security-btn lg"
            disabled={busy}
            onClick={() => revokeOthers.mutate()}
          >
            End all other devices
          </button>
        )}
        <button
          type="button"
          className="bold-security-btn lg"
          disabled={loggingOut}
          onClick={async () => {
            setLoggingOut(true)
            setLogoutError('')
            try {
              await apiFetch('session', { method: 'DELETE' })
              announceLogout()
            } catch {
              setLogoutError('Couldn’t log out. Try again.')
              setLoggingOut(false)
            }
          }}
        >
          {loggingOut ? 'Logging out…' : 'Log out this browser'}
        </button>
        {notice && !error && (
          <span role="status" className="bold-security-notice">
            {notice}
          </span>
        )}
      </span>
      {error && <p role="alert">{error}</p>}
      {logoutError && <p role="alert">{logoutError}</p>}
      {browsers.isError && !error && <p role="alert">Couldn’t load paired browsers.</p>}
    </section>
  )
}

export function PairCard({ origins }: { origins: readonly string[] }) {
  const browsers = useBrowsers()
  const onLocked = useOnLocked()
  const refreshSecurity = useRefreshSecurity()
  const [origin, setOrigin] = useState('')
  const [copied, setCopied] = useState<'idle' | 'copied' | 'manual'>('idle')
  const link = useRef<HTMLElement>(null)
  // A one-time link for a new device; it replaces any earlier unused link (including the console's).
  const invite = useMutation({
    mutationFn: async () =>
      PairingLinkSchema.parse(await post('session/pairing-links', origin ? { origin } : {})),
    onSuccess: () => {
      setCopied('idle')
      setPairedAtMint(browsers.data?.length ?? 0)
      return refreshSecurity()
    },
    onError: onLocked,
  })
  // The link (and its QR code) is shown only while it can still work: until it expires or a device has used it.
  const [pairedAtMint, setPairedAtMint] = useState(0)
  const [expiredLink, setExpiredLink] = useState<string | null>(null)
  const expiresAt = invite.data?.expiresAt
  useEffect(() => {
    if (!expiresAt) return
    // Also fires (next tick) for a link that is already past its time.
    const wait = Math.max(0, Date.parse(expiresAt) - Date.now())
    const timer = setTimeout(() => setExpiredLink(expiresAt), Math.min(wait, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [expiresAt])
  const expired = expiredLink !== null && expiredLink === expiresAt
  const linkShown = invite.data !== undefined && !expired
  // While a link is on screen, watch for the device that uses it.
  const refetchBrowsers = browsers.refetch
  useEffect(() => {
    if (!linkShown) return
    const timer = setInterval(() => void refetchBrowsers(), 5000)
    return () => clearInterval(timer)
  }, [linkShown, refetchBrowsers])
  const used = linkShown && (browsers.data?.length ?? 0) > pairedAtMint
  return (
    <section className="bold-security-card" aria-labelledby="security-pair">
      <h3 id="security-pair">Pair another device</h3>
      <p className="small">
        A one-time link for a new phone or computer. It works once and expires in 15 minutes.
      </p>
      {origins.length > 1 && (
        <fieldset className="bold-security-origins">
          <legend>Show the link for:</legend>
          {origins.map((candidate) => (
            <label key={candidate}>
              <input
                type="radio"
                name="pairing-origin"
                checked={(origin || origins[0]) === candidate}
                onChange={() => {
                  setOrigin(candidate)
                  // The link on screen was minted for the other address: drop it rather than show one that won't work.
                  invite.reset()
                }}
              />{' '}
              {originLabel(candidate)}
            </label>
          ))}
        </fieldset>
      )}
      {!(invite.data && linkShown && !used) && (
        <button
          type="button"
          className="bold-security-btn lg solid"
          disabled={invite.isPending}
          onClick={() => invite.mutate()}
        >
          {invite.data ? 'Get a new link' : 'Get a pairing link'}
        </button>
      )}
      {invite.data && (expired || used) && (
        <p role="status">
          {used ? 'That link was used.' : 'That link expired.'} Get a new one to pair another
          device.
        </p>
      )}
      {invite.data && linkShown && !used && (
        <div className="bold-security-link" role="group" aria-label="Pairing link">
          <QrCode text={invite.data.url} label="QR code for the pairing link" />
          <span className="bold-security-link-text">
            <code ref={link} onClick={() => selectText(link.current)}>
              {invite.data.url}
            </code>
            <span className="small muted">
              Open before{' '}
              {new Date(invite.data.expiresAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
              . Anyone with it can pair: send it only to yourself.
            </span>
            <button
              type="button"
              className="bold-security-btn"
              onClick={async () => {
                if (await copyText(invite.data.url)) setCopied('copied')
                else {
                  selectText(link.current)
                  setCopied('manual')
                }
              }}
            >
              {copied === 'copied' ? 'Copied' : 'Copy link'}
            </button>
          </span>
        </div>
      )}
      {copied === 'manual' && (
        <p role="status">The link is selected: press Ctrl+C (or ⌘C) to copy it.</p>
      )}
      {invite.isError && (
        <p role="alert">{securityFailure(invite.error, 'create a pairing link')}</p>
      )}
      <p className="small muted">
        On the Score machine itself: <code>scripts/score pair</code>, no password needed.
      </p>
    </section>
  )
}

/** Set · Change password (current / new / again, inline). The unlocked section is not the old password. */
export function PasswordCard() {
  const onLocked = useOnLocked()
  const refreshSecurity = useRefreshSecurity()
  const [changing, setChanging] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (next !== again) {
      setError('The two passwords don’t match.')
      return
    }
    const body = { password: next, current }
    setCurrent('')
    setNext('')
    setAgain('')
    setBusy(true)
    setError('')
    try {
      await apiFetch('session/security/password', { method: 'PUT', body: JSON.stringify(body) })
      setChanging(false)
      setNotice('Security password changed.')
      await refreshSecurity()
    } catch (caught) {
      onLocked(caught)
      setError(securityFailure(caught, 'save the password'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="bold-security-card span-all" aria-labelledby="security-password">
      <span className="bold-security-card-head">
        <span className="bold-security-card-title">
          <h3 id="security-password">Security password</h3>
          <span className="small">
            Set · it unlocks this section. Forgot it? <code>scripts/score password</code> on the
            Score machine.
          </span>
        </span>
        <button
          type="button"
          className="bold-security-btn lg"
          aria-expanded={changing}
          onClick={() => {
            setChanging((open) => !open)
            setError('')
            setNotice('')
          }}
        >
          {changing ? 'Cancel' : 'Change password'}
        </button>
      </span>
      {changing && (
        <form
          className="bold-security-change"
          aria-label="Change the security password"
          onSubmit={(event) => void submit(event)}
        >
          <label>
            Current password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
          </label>
          <label>
            New password (8+ characters)
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={256}
              value={next}
              onChange={(event) => setNext(event.target.value)}
            />
          </label>
          <label>
            New password again
            <input
              type="password"
              autoComplete="new-password"
              required
              value={again}
              onChange={(event) => setAgain(event.target.value)}
            />
          </label>
          <button type="submit" className="bold-security-btn lg solid" disabled={busy}>
            {busy ? 'Saving…' : 'Save new password'}
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && !error && <p role="status">{notice}</p>}
    </section>
  )
}

export function HttpsSetup() {
  return (
    <details className="bold-security-card span-all bold-security-https">
      <summary>HTTPS setup (for remote devices)</summary>
      <p className="small">
        Remote access is HTTPS only. Run <code>scripts/score tls</code> on the Score machine and
        install its certificate authority on each device (steps at <code>/setup/https</code>), or
        use your own certificate with <code>SCORE_TLS_CERT</code>, <code>SCORE_TLS_KEY</code> and an
        https <code>SCORE_PUBLIC_ORIGINS</code>, then restart.
      </p>
    </details>
  )
}
