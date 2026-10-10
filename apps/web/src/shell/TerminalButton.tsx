import { SecurityStatusSchema } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { apiFetch } from '../data/api.ts'

/** Top-bar shortcut to the web terminal (PLAN 7.3), shown only when the server offers one. */
export function TerminalButton() {
  const security = useQuery({
    queryKey: ['session', 'security'],
    queryFn: async () => SecurityStatusSchema.parse(await apiFetch('session/security')),
    staleTime: 60_000,
  })
  if (!security.data?.terminal || security.data.terminalUnavailable) return null
  return (
    <Link className="top-bar-terminal" to="/terminal" aria-label="Terminal" title="Terminal">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect
          x="1.5"
          y="2.5"
          width="13"
          height="11"
          rx="2.5"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M4.5 6.5 L7 8.5 L4.5 10.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M8.5 10.5 H11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </Link>
  )
}
