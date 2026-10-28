import { OpenTerminals } from '../routes/settings/TerminalSection.tsx'
import { Link } from 'react-router'
import type { AgentSummary } from '@score/contract'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { useStreamQuery } from '../data/query-client.ts'
import { agentsQuery } from '../routes/chat/queries.ts'
import { PasskeysPanel } from '../routes/settings/PasskeysPanel.tsx'
import { apiFetch } from '../data/api.ts'
import { useCallback, useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { securityKey } from '../routes/settings/settings-queries.ts'
import { DevicesCard, HttpsSetup, PairCard, PasswordCard } from './BoldSecurityCards.tsx'
import { SecurityFirstRun, SecurityLockCard } from './BoldSecurityGate.tsx'
import { clock, useCountdown, useDropToLocked } from './security-lock.ts'
import './bold-security.css'
import { useSecurityStatus } from '../routes/settings/settings-queries.ts'
import { useRunsOn } from './runs-on-queries.ts'

const SEPARATED = {
  no: 'Not separated',
  partly: 'Partly separated',
  unknown: 'Not known',
} as const

function runsOnLine(runsOn: ReturnType<typeof useRunsOn>): string {
  if (runsOn.isPending) return 'Reading Hermes…'
  if (runsOn.isError) return 'Couldn’t read where it runs.'
  const data = runsOn.data
  if (data.backend === 'local') return 'This machine, as you'
  if (data.backend === 'docker')
    return `Docker${data.docker?.image ? ` · ${data.docker.image}` : ''}`
  if (data.backend === 'ssh')
    return `SSH · ${data.ssh?.user ? `${data.ssh.user}@` : ''}${data.ssh?.host ?? 'no host'}`
  return `Another backend (${data.raw ?? 'unknown'})`
}

function AgentWhere({ agent }: { agent: AgentSummary }) {
  const runsOn = useRunsOn(agent.id)
  return (
    <li className="bold-agent-where">
      <span className="bold-agent-where-name">
        <AgentGlyph agent={agent} size="xs" bare decorative />
        <b>{agent.name}</b>
      </span>
      <span className="small muted">{runsOnLine(runsOn)}</span>
      {runsOn.data && (
        <span className={`badge runs-on-${runsOn.data.separated}`}>
          {SEPARATED[runsOn.data.separated]}
        </span>
      )}
      <Link className="link" to={`/b/team/${encodeURIComponent(agent.id)}#agent-where`}>
        Runs on
      </Link>
    </li>
  )
}

function UnlockPill({ until }: { until: string }) {
  const security = useSecurityStatus()
  const dropToLocked = useDropToLocked()
  const refetch = security.refetch
  const left = useCountdown(
    until,
    useCallback(() => void refetch(), [refetch]),
  )
  return (
    <span className="bold-security-pill-row" data-protected="flex">
      <span className="bold-security-pill">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <rect x="4" y="11" width="16" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 7.5-2" />
        </svg>
        Unlocked · locks in {clock(left)}
      </span>
      <button
        type="button"
        className="bold-security-btn lg"
        onClick={() => {
          void apiFetch('session/security/lock', { method: 'POST' }).catch(() => undefined)
          dropToLocked()
        }}
      >
        Lock now
      </button>
    </span>
  )
}

function Unlocked({ origins }: { origins: readonly string[] }) {
  const security = useSecurityStatus()
  const agents = useStreamQuery(agentsQuery).data ?? []
  return (
    <div className="bold-security-open" data-protected="grid" data-decision>
      <DevicesCard />
      <PairCard origins={origins} />
      <PasskeysPanel origins={origins} />

      <section className="bold-security-card" aria-labelledby="security-where">
        <h3 id="security-where">Where agents run</h3>
        {agents.length === 0 ? (
          <p className="small muted">No agents yet.</p>
        ) : (
          <ul className="bold-agent-where-list" aria-label="Where agents run">
            {agents.map((agent) => (
              <AgentWhere key={agent.id} agent={agent} />
            ))}
          </ul>
        )}
        <p className="small muted">
          Working with other teams? Give each team its own Score (one machine or VM each). Teams
          share work through the app they work on, with its tool server and triggers, not by sharing
          a Score.
        </p>
      </section>

      <section className="bold-security-card" aria-labelledby="security-terminal">
        <h3 id="security-terminal">Terminal in the browser</h3>
        <p className="small">
          A shell on the Score machine. Off unless Score was started with it, HTTPS only, closes
          after 15 minutes idle, at most two open.
        </p>
        {!security.data?.terminal && (
          <p className="small muted">
            {security.data?.terminalUnavailable
              ? `Unavailable: ${security.data.terminalUnavailable} (see docs/SETUP.md).`
              : 'Start Score with SCORE_TERMINAL=1 to turn it on. It needs the security password each time.'}
          </p>
        )}
        <Link className={security.data?.terminal ? 'btn sm primary' : 'btn sm'} to="/terminal">
          Open the terminal
        </Link>
        <OpenTerminals className="security-terminals" />
      </section>

      <PasswordCard />
      <HttpsSetup />
    </div>
  )
}

/** Remote access and security (PLAN 11.9b; locked behind the security password, 3.14.2). */
export function BoldSecurity() {
  const security = useSecurityStatus()
  const queryClient = useQueryClient()
  const unlockedUntil = security.data?.unlockedUntil ?? null
  // Leaving the page locks the section at once (fire and forget) and forgets the unlocked status.
  const wasUnlocked = useRef(false)
  useEffect(() => {
    wasUnlocked.current = unlockedUntil !== null
  }, [unlockedUntil])
  useEffect(
    () => () => {
      if (!wasUnlocked.current) return
      void apiFetch('session/security/lock', { method: 'POST' }).catch(() => undefined)
      queryClient.removeQueries({ queryKey: ['session', 'browsers'] })
      queryClient.removeQueries({ queryKey: ['session', 'passkeys'] })
      queryClient.removeQueries({ queryKey: securityKey })
    },
    [queryClient],
  )
  return (
    <div className="bold-security">
      <div className="bold-security-head">
        <h2 id="settings-security">Remote access and security</h2>
        {unlockedUntil && <UnlockPill until={unlockedUntil} />}
      </div>
      {security.isSuccess && !security.data.passwordSet && <SecurityFirstRun />}
      {security.isSuccess && security.data.passwordSet && !unlockedUntil && <SecurityLockCard />}
      {security.isSuccess && unlockedUntil && <Unlocked origins={security.data.origins} />}
      {security.isError && <p role="alert">Couldn’t read the security status.</p>}
    </div>
  )
}
