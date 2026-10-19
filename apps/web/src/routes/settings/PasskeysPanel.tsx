import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PasskeysSchema } from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { passkeyOrigin, registerPasskey } from '../../data/passkeys.ts'

const passkeysKey = ['session', 'passkeys'] as const

function failure(error: unknown, action: string): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
  if (code === 'wrong_password') return 'That is not the security password.'
  if (code === 'too_many_attempts')
    return 'Too many wrong passwords. Wait 15 minutes and try again.'
  if (code === 'passkeys_unavailable')
    return 'Passkeys need a domain name, not an IP address. Open Score at its Tailscale address.'
  // The browser refuses a ceremony the person cancelled or timed out.
  if (error instanceof Error && error.name === 'NotAllowedError')
    return 'The passkey was cancelled or timed out.'
  return `Couldn’t ${action}. Try again.`
}

/** Settings › Remote access › Passkeys. `password` is the security password the person typed above. */
export function PasskeysPanel({
  password,
  origins,
}: {
  password: string
  origins: readonly string[]
}) {
  const queryClient = useQueryClient()
  const [label, setLabel] = useState('')
  const [notice, setNotice] = useState('')
  const list = useQuery({
    queryKey: passkeysKey,
    queryFn: async () => PasskeysSchema.parse(await apiFetch('session/passkeys')),
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: passkeysKey })
  const add = useMutation({
    mutationFn: () => registerPasskey(password, label.trim() || 'Passkey'),
    onSuccess: () => {
      setLabel('')
      setNotice('Passkey added.')
      return refresh()
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`session/passkeys/${encodeURIComponent(id)}/remove`, {
        method: 'POST',
        body: JSON.stringify({ password }),
      }),
    onSuccess: () => {
      setNotice('Passkey removed.')
      return refresh()
    },
  })
  const ready = password.length >= 8
  const elsewhere = passkeyOrigin(origins)
  const error =
    (add.error && failure(add.error, 'add the passkey')) ||
    (remove.error && failure(remove.error, 'remove the passkey')) ||
    ''
  return (
    <>
      <h3>Passkeys</h3>
      <p>
        A passkey signs a browser in with your fingerprint, face or device PIN, with no pairing
        link. Adding or removing one needs the security password. Ending other pairings does not
        remove passkeys: remove a passkey here to stop it signing in.
      </p>
      {list.data && !list.data.available && (
        <p role="status">
          Passkeys need a domain name, so they don’t work on a LAN IP address.{' '}
          {elsewhere ? (
            <>
              Open Score at <a href={`${elsewhere}/settings/remote-access`}>{elsewhere}</a> to add
              one.
            </>
          ) : (
            'Open Score at its Tailscale (.ts.net) address to add one.'
          )}
        </p>
      )}
      {list.data?.available && (
        <form
          className="settings-form"
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
          <button
            type="submit"
            className="settings-pill settings-start"
            disabled={!ready || add.isPending}
          >
            {add.isPending ? 'Waiting for your device…' : 'Add a passkey'}
          </button>
        </form>
      )}
      <ul aria-label="Passkeys">
        {list.data?.items.map((passkey) => (
          <li key={passkey.id}>
            {passkey.label}, added {new Date(passkey.createdAt).toLocaleDateString()},{' '}
            {passkey.lastUsedAt
              ? `last used ${new Date(passkey.lastUsedAt).toLocaleString()}`
              : 'never used'}
            {passkey.flagged ? ' (blocked: this passkey may have been copied)' : ''}{' '}
            <button
              className="settings-pill"
              type="button"
              aria-label={`Remove passkey ${passkey.label}`}
              disabled={!ready || remove.isPending}
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
        <p className="settings-muted">No passkeys yet. Pairing links work either way.</p>
      )}
      {!ready && (
        <p className="settings-muted">Enter the security password above to manage passkeys.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && !error && <p role="status">{notice}</p>}
      {list.isError && <p className="settings-muted">Couldn’t load passkeys.</p>}
    </>
  )
}
