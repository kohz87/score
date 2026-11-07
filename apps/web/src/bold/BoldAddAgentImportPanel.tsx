import type { AgentSummary } from '@score/contract'
import { useEffect, useRef, useState } from 'react'
import { UploadProgress } from '../components/UploadProgress.tsx'
import { AGENT_ID_PATTERN, agentIdInput } from '../routes/team/agent-id.ts'
import { ProfileOperation } from '../routes/team/ProfileOperation.tsx'
import { useAgentImport } from '../routes/team/use-agent-import.ts'
import { availableStyle } from './bold-add-agent.ts'
import { Appearance } from './BoldAddAgentAppearance.tsx'
import { RunsProgress, WorksOnFields, useRunsOnSetup } from './BoldAddAgentRuns.tsx'
import { importMax, type AddedAgent, type Runs, type RunsOutcome } from './bold-add-agent-types.ts'

export function ImportProfilePanel({
  agents,
  close,
  onAdded,
  onBusy,
}: {
  agents: AgentSummary[]
  close: () => void
  onAdded: (agent: AddedAgent) => void
  onBusy: (busy: boolean) => void
}) {
  const [initial] = useState(() => availableStyle(agents))
  const draft = useAgentImport(agents, close, initial)
  const {
    inspection,
    id,
    setId,
    name,
    setName,
    role,
    setRole,
    style,
    setStyle,
    credentialsOk,
    setCredentialsOk,
    operation,
    status,
    sending,
    upload,
    start,
    taken,
    idValid,
    blocked,
  } = draft
  const [runs, setRuns] = useState<Runs>({
    backend: 'local',
    sshHost: '',
    sshUser: '',
    sshPort: '',
    sshKey: '',
  })
  const finished = useRef(false)
  const finish = (runsOutcome: RunsOutcome) => {
    if (finished.current) return
    finished.current = true
    onAdded({
      id: operation?.targetName ?? id,
      name: name || operation?.targetName || id,
      style,
      detail: 'Hermes agent, imported from an archive',
      another: false,
      runs: runsOutcome,
    })
  }
  const setup = useRunsOnSetup(operation?.state === 'completed', id, runs, (result) =>
    finish(result ? { kind: 'saved', runsOn: result } : { kind: 'local' }),
  )
  useEffect(() => {
    onBusy(upload.isPending || Boolean(operation) || start.isPending)
  }, [upload.isPending, operation, start.isPending, onBusy])

  if (operation)
    return (
      <div className="bold-add-operation">
        <ProfileOperation operation={operation} />
        {status.isError && (
          <p role="alert">
            Couldn’t refresh progress.{' '}
            <button type="button" className="link" onClick={() => void status.refetch()}>
              Try again
            </button>
          </p>
        )}
        <RunsProgress setup={setup} />
        {setup.state === 'error' && (
          <button
            type="button"
            className="btn ghost"
            data-protected="inline-flex"
            onClick={() =>
              finish({
                kind: 'failed',
                reason: setup.error ?? 'Score couldn’t change where it runs.',
              })
            }
          >
            Continue on this machine
          </button>
        )}
      </div>
    )

  if (!inspection)
    return (
      <div className="bold-add-form">
        <label className="bold-add-upload">
          <span className="lab">Profile export (.tar.gz, up to {importMax})</span>
          <input
            type="file"
            accept=".gz,.tgz,application/gzip,application/x-gzip"
            disabled={upload.isPending}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) upload.mutate(file)
            }}
          />
          <span className="small muted">
            A profile made with <code>hermes profile export</code>. Score inspects it without
            unpacking it into your Hermes profiles.
          </span>
        </label>
        {upload.isPending && sending && (
          <UploadProgress
            name={sending.name}
            progress={sending.progress}
            after="Checking the archive…"
          />
        )}
        {upload.error && <p role="alert">{upload.error.message}</p>}
        <div className="bold-add-main">
          <Appearance agents={agents} name={name} value={style} onChange={setStyle} />
          <div className="bold-add-fields">
            <p className="small muted">
              After Score checks the archive, you can choose the new agent’s id and what it does.
            </p>
          </div>
        </div>
      </div>
    )

  return (
    <form
      className="bold-add-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!blocked) start.mutate()
      }}
    >
      <div className="bold-add-main">
        <Appearance agents={agents} name={name} value={style} onChange={setStyle} />
        <div className="bold-add-fields">
          <section className="bold-add-archive" aria-labelledby="bold-add-archive-title">
            <h3 id="bold-add-archive-title">In this archive</h3>
            <dl>
              <div>
                <dt>Exported as</dt>
                <dd>{inspection.archiveRoot}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{inspection.model ?? 'Not set in the archive'}</dd>
              </div>
              <div>
                <dt>Skills</dt>
                <dd>{inspection.skills.join(', ') || 'None'}</dd>
              </div>
              <div>
                <dt>Plugins</dt>
                <dd>{inspection.plugins.join(', ') || 'None'}</dd>
              </div>
              <div>
                <dt>Credential files (names only)</dt>
                <dd>{inspection.credentialFiles.join(', ') || 'None'}</dd>
              </div>
            </dl>
            {inspection.warnings.map((warning) => (
              <p role="alert" key={warning}>
                {warning}
              </p>
            ))}
          </section>
          <label>
            <span className="lab">Name</span>
            <input
              className="field bold-add-name"
              autoFocus
              required
              pattern={AGENT_ID_PATTERN}
              title="Lowercase letters, digits, - and _"
              maxLength={64}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={id}
              aria-invalid={taken || (id !== '' && !idValid)}
              onChange={(event) => {
                const next = agentIdInput(event.target.value)
                setId(next)
                setName(next)
              }}
            />
          </label>
          {taken && (
            <p role="alert">
              An agent with this id already exists. Import never overwrites it: pick another id, or
              delete that agent first (Score keeps a private export when you do).
            </p>
          )}
          <label>
            <span className="lab">What does it do?</span>
            <textarea
              className="field"
              required
              maxLength={2000}
              rows={3}
              value={role}
              onChange={(event) => setRole(event.target.value)}
            />
          </label>
          <WorksOnFields runs={runs} setRuns={setRuns} />
          {inspection.credentialFiles.length > 0 && (
            <label className="check team-profile-confirm">
              <input
                type="checkbox"
                checked={credentialsOk}
                onChange={(event) => setCredentialsOk(event.target.checked)}
              />
              I know the archive contains credential files and want them copied into the new agent.
            </label>
          )}
          {start.error && <p role="alert">{start.error.message}</p>}
        </div>
      </div>
      <footer className="bold-add-footer">
        <span className="small muted">
          Hermes also adds a launcher script for the new profile in <code>~/.local/bin</code>.
        </span>
        <button type="button" className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button
          className="btn primary coding-add-commit"
          data-protected="inline-flex"
          disabled={blocked}
        >
          {start.isPending ? 'Starting…' : 'Import agent'}
        </button>
      </footer>
    </form>
  )
}
