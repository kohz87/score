import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  PairedBrowserSchema,
  PairedBrowsersSchema,
  PairingLinkSchema,
  RevokeOthersResponseSchema,
  SecurityStatusSchema,
} from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { copyText, selectText } from '../../data/clipboard.ts'
import { QrCode } from '../../components/QrCode.tsx'
import { announceLogout, remoteTransport } from '../../data/session.ts'
import { PasskeysPanel } from './PasskeysPanel.tsx'

const browsersKey = ['session', 'browsers'] as const
const securityKey = ['session', 'security'] as const

/** "LAN" for a local address, "ts.net" for a Tailscale name, else the host itself. */
export function originLabel(origin: string): string {
  const host = new URL(origin).hostname
  if (host.endsWith('.ts.net')) return 'ts.net'
  if (/^(?:\d+\.){3}\d+$/.test(host) || host.endsWith('.local') || host === 'localhost')
    return 'LAN'
  return host
}

function failure(error: unknown, action: string): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
  if (code === 'wrong_password') return 'That is not the security password.'
  if (code === 'too_many_attempts')
    return 'Too many wrong passwords. Wait 15 minutes and try again.'
  if (code === 'password_not_set') return 'Set a security password first.'
  if (code === 'bad_request') return 'Use 8 to 256 characters for the security password.'
  return `Could not ${action}. Please try again.`
}

function SetPassword({ change, onDone }: { change: boolean; onDone: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (next !== again) {
      setError('The two entries differ.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await apiFetch('session/security/password', {
        method: 'PUT',
        body: JSON.stringify({ password: next, ...(change ? { current } : {}) }),
      })
      onDone()
    } catch (caught) {
      setError(failure(caught, 'save the password'))
    } finally {
      setCurrent('')
      setNext('')
      setAgain('')
      setBusy(false)
    }
  }
  return (
    <form
      className="settings-form"
      aria-label={change ? 'Change the security password' : 'Set a security password'}
      onSubmit={(event) => void submit(event)}
    >
      {change && (
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
      )}
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
      {error && <p role="alert">{error}</p>}
      <button type="submit" className="settings-primary settings-start" disabled={busy}>
        {busy ? 'Saving…' : change ? 'Change password' : 'Set password'}
      </button>
    </form>
  )
}

export function RemoteSection() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [password, setPassword] = useState('')
  const [changing, setChanging] = useState(false)
  const [notice, setNotice] = useState('')
  const check = useMutation({
    mutationFn: () =>
      apiFetch('session/security/check', {
        method: 'POST',
        body: JSON.stringify({ password }),
      }),
  })
  const [copied, setCopied] = useState<'idle' | 'copied' | 'manual'>('idle')
  const link = useRef<HTMLElement>(null)
  const queryClient = useQueryClient()
  const remote = remoteTransport() !== undefined
  // The password lives only in this component while the page is open.
  useEffect(() => () => setPassword(''), [])
  const browsers = useQuery({
    queryKey: browsersKey,
    enabled: remote,
    queryFn: async () => PairedBrowsersSchema.parse(await apiFetch('session/browsers')).items,
  })
  const security = useQuery({
    queryKey: securityKey,
    enabled: remote,
    queryFn: async () => SecurityStatusSchema.parse(await apiFetch('session/security')),
  })
  const [origin, setOrigin] = useState('')
  const origins = security.data?.origins ?? []
  const withPassword = () => ({ method: 'POST', body: JSON.stringify({ password }) })
  const refresh = () => queryClient.invalidateQueries({ queryKey: browsersKey })
  const revoke = useMutation({
    mutationFn: (id: string) => apiFetch(`session/browsers/${id}/revoke`, withPassword()),
    onSuccess: () => {
      setNotice('Pairing terminated.')
      return refresh()
    },
  })
  const revokeOthers = useMutation({
    mutationFn: async () =>
      RevokeOthersResponseSchema.parse(
        await apiFetch('session/browsers/revoke-others', withPassword()),
      ),
    onSuccess: ({ revoked }) => {
      setNotice(
        revoked === 1 ? 'Terminated 1 other pairing.' : `Terminated ${revoked} other pairings.`,
      )
      return refresh()
    },
  })
  const renew = useMutation({
    mutationFn: async (id: string) =>
      PairedBrowserSchema.parse(await apiFetch(`session/browsers/${id}/renew`, withPassword())),
    onSuccess: () => {
      setNotice('Pairing renewed.')
      return refresh()
    },
  })
  // A one-time link for a new device; it replaces any earlier unused link (including the console's).
  const invite = useMutation({
    mutationFn: async () =>
      PairingLinkSchema.parse(
        await apiFetch('session/pairing-links', {
          method: 'POST',
          body: JSON.stringify({ password, ...(origin ? { origin } : {}) }),
        }),
      ),
    onSuccess: () => {
      setCopied('idle')
      setPairedAtMint(browsers.data?.length ?? 0)
    },
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
  if (!remote) return null
  const passwordSet = security.data?.passwordSet === true
  const ready = passwordSet && password.length >= 8
  const actionError =
    (revoke.error && failure(revoke.error, 'terminate the pairing')) ||
    (revokeOthers.error && failure(revokeOthers.error, 'terminate the pairings')) ||
    (renew.error && failure(renew.error, 'renew the pairing')) ||
    (invite.error && failure(invite.error, 'create a pairing link')) ||
    ''
  const busy = revoke.isPending || revokeOthers.isPending || renew.isPending || invite.isPending
  return (
    <section id="remote-access" className="settings-card" aria-labelledby="settings-remote-access">
      <h2 id="settings-remote-access">Remote access</h2>
      <p>
        Paired browsers can read all conversations and control Score. Pair only browsers you trust.
        Revoking access cannot erase data already downloaded.
      </p>
      <h3>TLS setup</h3>
      <p>
        Remote access is HTTPS only. Run <code>scripts/score tls</code> on the Score machine and
        install its certificate authority on each device (the setup guide at{' '}
        <code>/setup/https</code> has the steps), or configure your own certificate with{' '}
        <code>SCORE_TLS_CERT</code>, <code>SCORE_TLS_KEY</code> and an https{' '}
        <code>SCORE_PUBLIC_ORIGINS</code>, then restart.
      </p>

      <h3>Security password</h3>
      <p>
        Pairing another device, renewing and terminating pairings need this password, so a lost or
        compromised device can&apos;t invite others or lock you out. If you forget it, reset it on
        the Score machine with <code>scripts/score password</code>.
      </p>
      {security.isSuccess && !passwordSet && (
        <SetPassword
          change={false}
          onDone={() => {
            setNotice('Security password set.')
            void security.refetch()
          }}
        />
      )}
      {passwordSet && (
        <>
          <label className="settings-password">
            Security password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value)
                check.reset()
              }}
            />
          </label>
          <button
            type="button"
            className="settings-link settings-start"
            disabled={password.length < 8 || check.isPending}
            onClick={() => check.mutate()}
          >
            {check.isPending ? 'Checking…' : 'Check password'}
          </button>
          {check.isSuccess && <p role="status">That is the security password.</p>}
          {check.error && <p role="alert">{failure(check.error, 'check the password')}</p>}
          <button
            type="button"
            className="settings-link settings-start"
            aria-expanded={changing}
            onClick={() => setChanging((open) => !open)}
          >
            Change password
          </button>
          {changing && (
            <SetPassword
              change
              onDone={() => {
                setChanging(false)
                setNotice('Security password changed.')
              }}
            />
          )}
        </>
      )}

      <h3>Pair another device</h3>
      <p>
        Get a one-time link and open it on the new phone or computer. It works once and expires in
        15 minutes. (Typing <code>pair</code> in the server terminal still works too.)
      </p>
      <button
        className="settings-pill settings-start"
        type="button"
        disabled={!ready || busy}
        onClick={() => invite.mutate()}
      >
        {invite.data ? 'Get a new link' : 'Pair another device'}
      </button>
      {origins.length > 1 && (
        <fieldset className="settings-origins">
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
      {invite.data && (expired || used) && (
        <p role="status">
          {used ? 'That link was used.' : 'That link expired.'} Get a new one to pair another
          device.
        </p>
      )}
      {invite.data && linkShown && !used && (
        <div className="settings-command" role="group" aria-label="Pairing link">
          <p>
            Open this on the new device before{' '}
            {new Date(invite.data.expiresAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
            . Anyone with this link can pair, so send it only to yourself.
          </p>
          <QrCode text={invite.data.url} label="QR code for the pairing link" />
          <code
            ref={link}
            className="settings-command-text"
            onClick={() => selectText(link.current)}
          >
            {invite.data.url}
          </code>
          <div className="settings-command-actions">
            <button
              type="button"
              className="settings-pill"
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
          </div>
          {copied === 'manual' && (
            <p role="status">The link is selected: press Ctrl+C (or ⌘C) to copy it.</p>
          )}
        </div>
      )}

      <h3>Paired browsers</h3>
      <ul aria-label="Paired browsers">
        {browsers.data?.map((browser) => (
          <li key={browser.id}>
            {browser.label.slice(0, 60)} from {browser.address}, last seen{' '}
            {new Date(browser.lastSeenAt).toLocaleString()}, access until{' '}
            {new Date(browser.expiresAt).toLocaleDateString()}
            {browser.current ? ' (this browser)' : ''}{' '}
            <button
              className="settings-pill"
              type="button"
              aria-label={`Renew ${browser.current ? 'this browser' : browser.label.slice(0, 60)}`}
              disabled={!ready || busy}
              onClick={() => renew.mutate(browser.id)}
            >
              Renew
            </button>{' '}
            {!browser.current && (
              <button
                className="settings-pill"
                type="button"
                aria-label={`Terminate ${browser.label.slice(0, 60)}`}
                disabled={!ready || busy}
                onClick={() => revoke.mutate(browser.id)}
              >
                Terminate
              </button>
            )}
          </li>
        ))}
      </ul>
      {(browsers.data?.length ?? 0) > 1 && (
        <button
          className="settings-pill settings-start"
          type="button"
          disabled={!ready || busy}
          onClick={() => revokeOthers.mutate()}
        >
          Terminate all other pairings
        </button>
      )}
      {security.isSuccess && !passwordSet && (
        <p className="settings-muted">Set a security password to manage pairings.</p>
      )}
      {passwordSet && password.length < 8 && (
        <p className="settings-muted">Enter the security password above to manage pairings.</p>
      )}
      {actionError && <p role="alert">{actionError}</p>}
      {notice && !actionError && <p role="status">{notice}</p>}
      {browsers.isError && <p role="alert">Could not load paired browsers.</p>}

      {passwordSet && <PasskeysPanel password={password} origins={origins} />}

      <button
        className="settings-pill settings-start"
        type="button"
        disabled={pending}
        onClick={async () => {
          if (pending) return
          setPending(true)
          setError('')
          try {
            await apiFetch('session', { method: 'DELETE' })
            announceLogout()
          } catch {
            setError('Could not log out. Try again.')
            setPending(false)
          }
        }}
      >
        {pending ? 'Logging out…' : 'Log out this browser'}
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
