import { lazy, Suspense } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { BoldClassicPage } from './BoldClassicPage.tsx'

// The terminal brings xterm.js: loaded on first visit. The page itself (password or passkey check, ticket) is the
// classic one, unchanged.
const LazyTerminalPage = lazy(async () => ({
  default: (await import('../routes/terminal/TerminalPage.tsx')).TerminalPage,
}))

export type TerminalReturnState = { terminalFrom?: string }

/** Where Back goes: the page the terminal was opened from, else the room. */
export function terminalBackTarget(state: unknown): string {
  const from = (state as TerminalReturnState | null)?.terminalFrom
  return typeof from === 'string' && from.startsWith('/b') && !from.startsWith('/b/terminal')
    ? from
    : '/b'
}

/** The web terminal inside the bold frame (2.1.3), with a Back to where the person was. */
export function BoldTerminalPage() {
  const navigate = useNavigate()
  const location = useLocation()
  return (
    <BoldClassicPage>
      <button
        type="button"
        className="bold-terminal-back"
        onClick={() => void navigate(terminalBackTarget(location.state))}
      >
        ← Back
      </button>
      <Suspense fallback={<p role="status">Opening Terminal…</p>}>
        <LazyTerminalPage />
      </Suspense>
    </BoldClassicPage>
  )
}
