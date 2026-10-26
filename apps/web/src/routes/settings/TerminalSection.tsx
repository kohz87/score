import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { TerminalSessionsSchema } from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { useSecurityStatus } from './settings-queries.ts'

const sessionsKey = ['terminal', 'sessions'] as const

/** The open terminals with a Close button each; nothing while the terminal is off. Used by Settings › Remote access and security. */
export function OpenTerminals({ className }: { className?: string }) {
  const queryClient = useQueryClient()
  const security = useSecurityStatus()
  const enabled = security.data?.terminal === true
  const sessions = useQuery({
    queryKey: sessionsKey,
    enabled,
    refetchInterval: 5000,
    queryFn: async () => TerminalSessionsSchema.parse(await apiFetch('terminal/sessions')).items,
  })
  const close = useMutation({
    mutationFn: (id: string) => apiFetch(`terminal/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionsKey }),
  })
  if (!enabled) return null
  return (
    <div className={className}>
      <ul aria-label="Open terminals" className="listrow-list">
        {sessions.data?.map((session) => (
          <li key={session.id}>
            Opened {new Date(session.openedAt).toLocaleTimeString()} from {session.address}, last
            active {new Date(session.lastActivityAt).toLocaleTimeString()}{' '}
            <button
              type="button"
              className="btn sm"
              disabled={close.isPending}
              onClick={() => close.mutate(session.id)}
            >
              Close
            </button>
          </li>
        ))}
      </ul>
      {sessions.data?.length === 0 && <p className="small muted">No terminals are open.</p>}
    </div>
  )
}

/** Settings: is the web terminal on, and which terminals are open right now (with a Close button). */
export function TerminalSection() {
  const security = useSecurityStatus()
  // Off (the default): nothing here. Settings › Remote access says so.
  if (security.data?.terminal !== true) return null
  return (
    <section id="terminal" className="settings-card" aria-labelledby="settings-terminal">
      <h2 id="settings-terminal">Terminal</h2>
      <p>
        The web terminal is <strong>enabled</strong>: a shell on the Score machine, for paired
        browsers that confirm the security password or a passkey each time.{' '}
        <Link to="/terminal">Open the terminal</Link>
      </p>
      <OpenTerminals />
    </section>
  )
}
