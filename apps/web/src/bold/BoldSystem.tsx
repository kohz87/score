import { Link } from 'react-router'
import { AboutSection } from '../routes/settings/AboutSection.tsx'
import { BackupSection } from '../routes/settings/BackupSection.tsx'
import { LogsSection } from '../routes/settings/LogsSection.tsx'
import { SharesSection } from '../routes/settings/SharesSection.tsx'
import { TerminalSection } from '../routes/settings/TerminalSection.tsx'
import { useSecurityStatus } from '../routes/settings/settings-queries.ts'
import { AgentUsage } from '../routes/knowledge/AgentUsage.tsx'
import { formatBytes } from '../routes/knowledge/knowledge-files.ts'
import {
  knowledgeFailure,
  useKnowledgeActions,
  useKnowledgeInfo,
} from '../routes/knowledge/knowledge-queries.ts'
import { useNow, useTeamPause } from '../routes/now/now-queries.ts'

/** The classic Knowledge settings, with the vault summary and both agent switches. */
function LibraryAccess() {
  const info = useKnowledgeInfo()
  const actions = useKnowledgeActions()
  return (
    <section className="card" aria-labelledby="system-library">
      <h3 id="system-library">Library access</h3>
      <p className="small muted">
        When on, agents can search, read and write notes in Library. Files with names like .env or
        keys are never served, but Score can’t recognise every secret, so don’t store secrets in
        notes.
      </p>
      {info.isPending && <p className="small muted">Loading…</p>}
      {info.isError && <p role="alert">Couldn’t load the Library settings.</p>}
      {info.data && (
        <>
          <dl className="kn-settings">
            <div>
              <dt>Knowledge folder</dt>
              <dd>
                <code>{info.data.vault}</code>
              </dd>
            </div>
            <div>
              <dt>Notes</dt>
              <dd>{info.data.notes}</dd>
            </div>
            <div>
              <dt>Files</dt>
              <dd>
                {info.data.documents} {info.data.documents === 1 ? 'file' : 'files'},{' '}
                {formatBytes(info.data.documentBytes)} (PDF, DOCX, CSV, images and other uploads)
              </dd>
            </div>
            <div>
              <dt>Git</dt>
              <dd>
                {info.data.gitAvailable
                  ? 'Versioned with git: every save is a commit.'
                  : 'Not available. Notes still save; history and undo are off.'}
              </dd>
            </div>
          </dl>
          <label className="check small">
            <input
              type="checkbox"
              role="switch"
              checked={info.data.agentAccess}
              disabled={actions.setAgentAccess.isPending}
              onChange={(event) => actions.setAgentAccess.mutate(event.target.checked)}
            />
            Agents can use Library
          </label>
          <label className="check small">
            <input
              type="checkbox"
              role="switch"
              checked={info.data.memoryNotes}
              disabled={actions.setMemoryNotes.isPending}
              onChange={(event) => actions.setMemoryNotes.mutate(event.target.checked)}
            />
            Save compacted summaries as memory notes
          </label>
          <p className="small muted">
            When you compact an agent’s context, Score saves the summary as a note under Memory in
            Library, with a list for each month.
          </p>
          <AgentUsage />
        </>
      )}
      {actions.setAgentAccess.isError && (
        <p role="alert">{knowledgeFailure(actions.setAgentAccess.error, 'change this setting')}</p>
      )}
      {actions.setMemoryNotes.isError && (
        <p role="alert">{knowledgeFailure(actions.setMemoryNotes.error, 'change this setting')}</p>
      )}
      <Link className="link" to="/knowledge">
        Open Library
      </Link>
    </section>
  )
}

function PauseEveryone() {
  const now = useNow()
  const pause = useTeamPause()
  const paused = now.data?.paused ?? false
  return (
    <section
      className="card system-pause"
      aria-labelledby="system-pause"
      data-decision
      data-protected="flex"
    >
      <span className="grow">
        <b id="system-pause">Pause everyone</b>{' '}
        <span className="muted">
          · agents finish their current step, then wait until you resume
        </span>
      </span>
      <button
        type="button"
        className="btn"
        disabled={pause.isPending || !now.data}
        onClick={() => pause.mutate({ paused: !paused })}
      >
        {paused ? 'Resume everyone' : 'Pause everyone'}
      </button>
      {pause.isError && (
        <p role="alert" className="small">
          Couldn’t {paused ? 'resume' : 'pause'} the team. Try again.
        </p>
      )}
    </section>
  )
}

function TerminalAccess() {
  const security = useSecurityStatus()
  if (security.data?.terminal) return <TerminalSection />
  return (
    <section className="card" aria-labelledby="system-terminal">
      <h3 id="system-terminal">Terminal in the browser</h3>
      <p className="small muted">
        {security.isPending
          ? 'Loading the terminal status…'
          : security.data?.terminalUnavailable
            ? `Unavailable: ${security.data.terminalUnavailable} (see docs/SETUP.md).`
            : 'Off unless Score was started with SCORE_TERMINAL=1. It is HTTPS only and asks for the security password each time.'}
      </p>
      <Link className="link" to="/terminal">
        Open the terminal
      </Link>
    </section>
  )
}

/** PLAN 11.9b: Score service and updates, backups, logs, pause everyone, Library access, Shares and Terminal. */
export function BoldSystem() {
  return (
    <div className="bold-system" id="system">
      <h2>System</h2>
      <div className="grid2 system-grid">
        <AboutSection heading="Score" />
        <BackupSection heading="Backups" />
        <LibraryAccess />
        <SharesSection />
        <div className="span2">
          <TerminalAccess />
        </div>
        <div className="span2 system-logs">
          <LogsSection />
        </div>
        <PauseEveryone />
      </div>
    </div>
  )
}
