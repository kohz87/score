import { Link } from 'react-router'
import { RemoteSection } from '../routes/settings/RemoteSection.tsx'
import { useSecurityStatus } from '../routes/settings/settings-queries.ts'

/** PLAN 11.9b: Remote access and security, with the Where agents run card filled in by 11.8a. */
export function BoldSecurity() {
  const security = useSecurityStatus()

  return (
    <div className="bold-security">
      <h2 id="settings-security">Remote access and security</h2>

      <section className="card" aria-labelledby="security-where">
        <h3 id="security-where">Where agents run</h3>
        <p className="small muted">Comes in 11.8a</p>
        <p className="small muted">
          Working with other teams? Give each team its own Score (one machine or VM each). Teams
          share work through the app they work on, with its tool server and triggers, not by sharing
          a Score.
        </p>
      </section>

      <RemoteSection available heading={null} labelledBy="settings-security" showTerminal={false} />

      <section className="card" aria-labelledby="security-terminal">
        <h3 id="security-terminal">Terminal in the browser</h3>
        <p className="small muted">
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
      </section>
    </div>
  )
}
