import { SecurityStatusSchema } from '@score/contract'
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { apiFetch } from '../data/api.ts'

/**
 * Top-bar shortcut to the web terminal (PLAN 7.3), shown only when the server offers one. Reads the status itself (the
 * shell renders outside the query provider) and never on the pairing page, which must make no other request.
 */
export function TerminalButton() {
  const pairing = useLocation().pathname.startsWith('/pair')
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    if (pairing) return
    let alive = true
    apiFetch('session/security')
      .then((body) => {
        const status = SecurityStatusSchema.parse(body)
        if (alive) setAvailable(status.terminal && !status.terminalUnavailable)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [pairing])
  if (pairing || !available) return null
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
