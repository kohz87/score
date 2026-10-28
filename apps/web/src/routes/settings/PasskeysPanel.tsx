import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PasskeysSchema } from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { passkeyOrigin, registerPasskey } from '../../data/passkeys.ts'
import {
  passkeysKey,
  securityFailure,
  useOnLocked,
  useRefreshSecurity,
} from '../../bold/security-lock.ts'

/** Settings › Remote access and security › Passkeys. Only rendered while the section is unlocked. */
export function PasskeysPanel({ origins }: { origins: readonly string[] }) {
  const queryClient = useQueryClient()
  const onLocked = useOnLocked()
  const refreshSecurity = useRefreshSecurity()
  const [label, setLabel] = useState('')
  const [notice, setNotice] = useState('')
  const list = useQuery({
    queryKey: passkeysKey,
    queryFn: async () => {
      try {
        return PasskeysSchema.parse(await apiFetch('session/passkeys'))
      } catch (error) {
        onLocked(error)
        throw error
      }
    },
  })
  const refresh = () => {
    void refreshSecurity()
    return queryClient.invalidateQueries({ queryKey: passkeysKey })
  }
  const add = useMutation({
    mutationFn: () => registerPasskey(label.trim() || 'Passkey'),
    onSuccess: () => {
      setLabel('')
      setNotice('Passkey added.')
      return refresh()
    },
    onError: onLocked,
  })
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`session/passkeys/${encodeURIComponent(id)}/remove`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      setNotice('Passkey removed.')
      return refresh()
    },
    onError: onLocked,
  })
  const elsewhere = passkeyOrigin(origins)
  const error =
    (add.error ? securityFailure(add.error, 'add the passkey') : '') ||
    (remove.error ? securityFailure(remove.error, 'remove the passkey') : '') ||
    ''
  return (
    <section className="bold-security-card" aria-labelledby="security-passkeys">
      <h3 id="security-passkeys">Passkeys</h3>
      <p className="small">
        Sign this browser in again with a fingerprint or screen lock instead of a new pairing link.
        Ending other pairings does not remove passkeys: remove a passkey here to stop it signing in.
      </p>
      {list.data && !list.data.available && (
        <p role="status" className="small">
          Passkeys need a domain name, so they don’t work on a LAN IP address.{' '}
          {elsewhere ? (
            <>
              Open Score at <a href={`${elsewhere}/b/settings/security`}>{elsewhere}</a> to add one.
            </>
          ) : (
            'Open Score at its Tailscale (.ts.net) address to add one.'
          )}
        </p>
      )}
      <ul aria-label="Passkeys" className="bold-security-rows">
        {list.data?.items.map((passkey) => (
          <li key={passkey.id} className="bold-security-passkey">
            <span>
              <b>{passkey.label}</b>{' '}
              <span className="small muted">
                · added{' '}
                {new Date(passkey.createdAt).toLocaleDateString([], {
                  day: 'numeric',
                  month: 'short',
                })}
                ,{' '}
                {passkey.lastUsedAt
                  ? `last used ${new Date(passkey.lastUsedAt).toLocaleString()}`
                  : 'never used'}
                {passkey.flagged ? ' (blocked: this passkey may have been copied)' : ''}
              </span>
            </span>
            <button
              className="bold-security-btn"
              type="button"
              aria-label={`Remove passkey ${passkey.label}`}
              disabled={remove.isPending}
              onClick={() => {
                setNotice('')
                remove.mutate(passkey.id)
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {list.data && list.data.items.length === 0 && (
        <p className="small muted">No passkeys yet. Pairing links work either way.</p>
      )}
      {list.data?.available && (
        <form
          className="bold-security-passkey-add"
          aria-label="Add a passkey"
          onSubmit={(event) => {
            event.preventDefault()
            setNotice('')
            add.mutate()
          }}
        >
          <label>
            Passkey name
            <input
              type="text"
              maxLength={60}
              placeholder="Phone"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <button type="submit" className="bold-security-btn lg" disabled={add.isPending}>
            {add.isPending ? 'Waiting for your device…' : 'Add a passkey'}
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && !error && <p role="status">{notice}</p>}
      {list.isError && !error && <p className="small muted">Couldn’t load passkeys.</p>}
    </section>
  )
}
