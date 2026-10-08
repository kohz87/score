import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PairedBrowsersSchema } from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { announceLogout, remoteTransport } from '../../data/session.ts'

export function RemoteSection() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const queryClient = useQueryClient()
  const remote = remoteTransport() !== undefined
  const browsers = useQuery({
    queryKey: ['session', 'browsers'],
    enabled: remote,
    queryFn: async () => PairedBrowsersSchema.parse(await apiFetch('session/browsers')).items,
  })
  const revoke = useMutation({
    mutationFn: (id: string) => apiFetch(`session/browsers/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['session', 'browsers'] }),
  })
  if (!remote) return null
  return (
    <section id="remote-access" className="settings-card" aria-labelledby="settings-remote-access">
      <h2 id="settings-remote-access">Remote access</h2>
      <p>
        Paired browsers can read all conversations and control Score. Pair only browsers you trust.
        Revoking access cannot erase data already downloaded.
      </p>
      <h3>TLS setup</h3>
      <p>
        Use a trusted certificate for your Score hostname. Configure <code>SCORE_TLS_CERT</code> and{' '}
        <code>SCORE_TLS_KEY</code>, set <code>SCORE_PUBLIC_ORIGINS</code> to its HTTPS origin, and
        remove <code>SCORE_REMOTE_INSECURE_HTTP</code> before restarting.
      </p>
      <p>
        To pair another browser, type <code>pair</code> in the server terminal and open the new
        link.
      </p>
      <h3>Paired browsers</h3>
      <ul aria-label="Paired browsers">
        {browsers.data?.map((browser) => (
          <li key={browser.id}>
            {browser.label.slice(0, 60)} from {browser.address}, last seen{' '}
            {new Date(browser.lastSeenAt).toLocaleString()}
            {browser.current ? ' (this browser)' : ''}{' '}
            {!browser.current && (
              <button
                className="settings-pill"
                type="button"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(browser.id)}
              >
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
      {(browsers.isError || revoke.isError) && (
        <p role="alert">Could not update paired browsers.</p>
      )}
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
