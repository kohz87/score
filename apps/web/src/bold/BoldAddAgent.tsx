import { ShapeSchema, type AgentStyle, type AgentSummary, type CodingAgent } from '@score/contract'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { ModelPicker as HermesModelPicker } from '../components/ModelPicker.tsx'
import { UploadProgress } from '../components/UploadProgress.tsx'
import { AGENT_ID_PATTERN, agentIdInput } from '../routes/team/agent-id.ts'
import { shapeLabel } from '../routes/team/AgentAppearanceFields.tsx'
import {
  PermissionPicker,
  ReadAccessWarning,
  useCodingAgentDraft,
} from '../routes/team/CodingAgent.tsx'
import { ModelPicker as CodingModelPicker } from '../routes/team/ModelPicker.tsx'
import { ProfileOperation } from '../routes/team/ProfileOperation.tsx'
import { availableStyle, colourChoices, saveRunsOn, type WorksOnChoice } from './bold-add-agent.ts'
import { emptyAgentInput, useAgentCreateDraft } from '../routes/team/use-agent-create.ts'
import { useAgentImport } from '../routes/team/use-agent-import.ts'
import './bold-add-agent.css'

type From = 'new' | 'import' | 'coding'

type AddedAgent = {
  id: string
  name: string
  style: AgentStyle
  detail: string
  another: boolean
}

const fromLabels: { value: From; label: string }[] = [
  { value: 'new', label: 'New agent' },
  { value: 'import', label: 'Bring in a Hermes profile' },
  { value: 'coding', label: 'A coding tool' },
]

const worksOnLabels: { value: WorksOnChoice['backend']; label: string }[] = [
  { value: 'local', label: 'This machine as you' },
  { value: 'docker', label: 'Docker sandbox' },
  { value: 'ssh', label: 'Another machine (SSH)' },
]

function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

/**
 * The bold Team page's Add agent action (PLAN 11.8c). The button and `?add=agent` open one dialog over the same Team
 * route, so closing it keeps the person on the team and an address can be shared before the dialog opens.
 */
export function BoldAddAgent({ agents, phone }: { agents: AgentSummary[]; phone: boolean }) {
  const [params, setParams] = useSearchParams()
  const trigger = useRef<HTMLButtonElement>(null)
  const open = params.get('add') === 'agent'
  const openDialog = () => {
    const next = new URLSearchParams(params)
    next.set('add', 'agent')
    setParams(next, { replace: true })
  }
  const close = () => {
    const next = new URLSearchParams(params)
    next.delete('add')
    setParams(next, { replace: true })
    requestAnimationFrame(() => trigger.current?.focus())
  }
  return (
    <>
      <button ref={trigger} type="button" className="btn primary" onClick={openDialog}>
        {phone ? 'Add' : 'Add an agent'}
      </button>
      {open && <BoldAddAgentDialog agents={agents} close={close} />}
    </>
  )
}

function BoldAddAgentDialog({ agents, close }: { agents: AgentSummary[]; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [from, setFrom] = useState<From>('new')
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState<AddedAgent | null>(null)
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  const another = () => {
    setAdded(null)
    setBusy(false)
    setFrom('new')
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="bold-add-dialog"
      aria-label="Add an agent"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      {added ? (
        <AddedView added={added} close={close} {...(added.another ? { another } : {})} />
      ) : (
        <>
          <header className="bold-add-head">
            <h2>Add an agent</h2>
            <button type="button" className="icon-btn" onClick={close} aria-label="Close">
              <CloseIcon />
            </button>
          </header>
          <div className="bold-add-from" role="radiogroup" aria-label="Start from">
            {fromLabels.map((choice) => (
              <button
                key={choice.value}
                type="button"
                role="radio"
                aria-checked={from === choice.value}
                className={from === choice.value ? 'on' : undefined}
                disabled={busy}
                onClick={() => setFrom(choice.value)}
              >
                <b>{choice.label}</b>
              </button>
            ))}
          </div>
          {from === 'new' && (
            <NewAgentPanel
              agents={agents}
              close={close}
              onAdded={(agent) => setAdded(agent)}
              onBusy={setBusy}
            />
          )}
          {from === 'import' && (
            <ImportProfilePanel
              agents={agents}
              close={close}
              onAdded={(agent) => setAdded(agent)}
              onBusy={setBusy}
            />
          )}
          {from === 'coding' && (
            <CodingAgentPanel
              agents={agents}
              close={close}
              onAdded={(agent) => setAdded(agent)}
              onBusy={setBusy}
            />
          )}
        </>
      )}
    </dialog>
  )
}

function AddedView({
  added,
  close,
  another,
}: {
  added: AddedAgent
  close: () => void
  another?: () => void
}) {
  return (
    <section className="bold-add-added" role="status">
      <AgentGlyph
        agent={{ id: added.id, name: added.name, style: added.style }}
        size="lg"
        activity="idle"
      />
      <h2>{added.name} joined the team</h2>
      <p className="muted">{added.detail}</p>
      <div className="bold-add-added-actions">
        <Link
          className="btn primary"
          to={`/b/team/${encodeURIComponent(added.id)}`}
          onClick={close}
          autoFocus
        >
          Open {added.name}
        </Link>
        {another && (
          <button type="button" className="btn ghost" onClick={another}>
            Add another
          </button>
        )}
        <button type="button" className="btn ghost" onClick={close}>
          Close
        </button>
      </div>
    </section>
  )
}

/** Shape, colour and the live mark: the same 20 contract shapes, with colours already on the team faded. */
function Appearance({
  agents,
  name,
  value,
  onChange,
}: {
  agents: AgentSummary[]
  name: string
  value: AgentStyle
  onChange: (style: AgentStyle) => void
}) {
  const colours = colourChoices(agents)
  return (
    <div className="bold-add-appearance">
      <div className="bold-add-preview">
        <AgentGlyph
          agent={{ id: 'new-agent', name: name || 'New agent', style: value }}
          size="lg"
          describeShape
          activity="idle"
        />
      </div>
      <div className="bold-add-shapes" role="radiogroup" aria-label="Shape">
        {ShapeSchema.options.map((shape) => {
          const selected = value.shape === shape
          const label = shapeLabel(shape)
          return (
            <button
              key={shape}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={label}
              className={selected ? 'on' : undefined}
              onClick={() => onChange({ ...value, shape })}
            >
              <AgentGlyph
                agent={{ id: `shape-${shape}`, name: label, style: { ...value, shape } }}
                size="sm"
                plain
                bare
                decorative
              />
            </button>
          )
        })}
      </div>
      <div className="bold-add-colours" role="radiogroup" aria-label="Colour">
        {colours.map(({ colour, takenBy }) => {
          const selected = value.color.toLowerCase() === colour
          return (
            <button
              key={colour}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`Colour ${colour}${takenBy ? `, used by ${takenBy}` : ''}`}
              className={selected ? 'on' : undefined}
              disabled={takenBy !== null}
              style={{ background: colour }}
              onClick={() => onChange({ ...value, color: colour })}
            />
          )
        })}
      </div>
      <span className="bold-add-hint">20 shapes · Faded colours are taken</span>
    </div>
  )
}

type Runs = {
  backend: WorksOnChoice['backend']
  sshHost: string
  sshUser: string
  sshPort: string
  sshKey: string
}

function runsChoice(runs: Runs): WorksOnChoice {
  if (runs.backend === 'docker') return { backend: 'docker' }
  if (runs.backend === 'ssh')
    return {
      backend: 'ssh',
      host: runs.sshHost.trim(),
      user: runs.sshUser.trim(),
      ...(runs.sshPort.trim() ? { port: Number(runs.sshPort) } : {}),
      ...(runs.sshKey.trim() ? { keyPath: runs.sshKey.trim() } : {}),
    }
  return { backend: 'local' }
}

function WorksOnFields({ runs, setRuns }: { runs: Runs; setRuns: (runs: Runs) => void }) {
  return (
    <div className="bold-add-works">
      <label>
        <span className="lab">Works on</span>
        <select
          className="field"
          value={runs.backend}
          onChange={(event) => setRuns({ ...runs, backend: event.target.value as Runs['backend'] })}
        >
          {worksOnLabels.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      {runs.backend === 'ssh' && (
        <div className="bold-add-ssh">
          <label>
            <span className="lab">Host</span>
            <input
              className="field"
              required
              value={runs.sshHost}
              onChange={(event) => setRuns({ ...runs, sshHost: event.target.value })}
            />
          </label>
          <label>
            <span className="lab">User</span>
            <input
              className="field"
              required
              value={runs.sshUser}
              onChange={(event) => setRuns({ ...runs, sshUser: event.target.value })}
            />
          </label>
          <label>
            <span className="lab">Port (optional)</span>
            <input
              className="field"
              type="number"
              min={1}
              max={65535}
              value={runs.sshPort}
              onChange={(event) => setRuns({ ...runs, sshPort: event.target.value })}
            />
          </label>
          <label className="span2">
            <span className="lab">Private key path (optional)</span>
            <input
              className="field"
              placeholder="/home/you/.ssh/id_ed25519"
              value={runs.sshKey}
              onChange={(event) => setRuns({ ...runs, sshKey: event.target.value })}
            />
          </label>
        </div>
      )}
      <span className="small muted">
        {runs.backend === 'local'
          ? 'Runs as you on this machine; its terminal tools are not separated.'
          : runs.backend === 'docker'
            ? 'Score checks Docker after setup. If it is unavailable, you will see the reason.'
            : 'Score stores the key path only; it never reads the key.'}
      </span>
    </div>
  )
}

type RunsSetup = ReturnType<typeof useRunsOnSetup>

function useRunsOnSetup(ready: boolean, agentId: string, runs: Runs, onReady: () => void) {
  const [state, setState] = useState<'idle' | 'saving' | 'error' | 'ready'>('idle')
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)
  const saveRef = useRef<() => Promise<void>>(async () => undefined)
  const save = async () => {
    setState('saving')
    setError(null)
    try {
      const choice = runsChoice(runs)
      if (choice.backend !== 'local') await saveRunsOn(agentId, choice)
      setState('ready')
      onReady()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t set where this agent runs.')
      setState('error')
    }
  }
  useEffect(() => {
    saveRef.current = save
  })
  useEffect(() => {
    if (!ready || started.current) return
    started.current = true
    void saveRef.current()
  }, [ready])
  return { state, error, retry: save }
}

function RunsProgress({ setup }: { setup: RunsSetup }) {
  if (setup.state === 'saving')
    return (
      <p className="bold-add-runs-status" role="status">
        Setting where it runs…
      </p>
    )
  if (setup.state === 'error')
    return (
      <div className="bold-add-error" role="alert">
        <p>{setup.error}</p>
        <button type="button" className="btn sm" onClick={() => void setup.retry()}>
          Try again
        </button>
      </div>
    )
  return null
}

function NewAgentPanel({
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
  const draft = useAgentCreateDraft(emptyAgentInput(initial))
  const { input, preview, confirmed, operation, status, review, create, change, setConfirmed } =
    draft
  const [runs, setRuns] = useState<Runs>({
    backend: 'local',
    sshHost: '',
    sshUser: '',
    sshPort: '',
    sshKey: '',
  })
  const finished = useRef(false)
  const finish = () => {
    if (finished.current) return
    finished.current = true
    onAdded({
      id: operation?.targetName ?? input.id,
      name: input.name || operation?.targetName || input.id,
      style: input.style,
      detail: [
        'Hermes agent',
        input.model,
        input.cloneFrom ? `copied from ${input.cloneFrom}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      another: true,
    })
  }
  const setup = useRunsOnSetup(operation?.state === 'completed', input.id, runs, finish)
  useEffect(() => {
    onBusy(Boolean(operation) || review.isPending || create.isPending)
  }, [operation, review.isPending, create.isPending, onBusy])

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
          <button type="button" className="btn ghost" onClick={finish}>
            Continue without changing where it runs
          </button>
        )}
      </div>
    )

  const canCreate = Boolean(
    preview &&
    preview.blockers.length === 0 &&
    (!input.cloneFrom || confirmed) &&
    (runs.backend !== 'ssh' || (runs.sshHost.trim() && runs.sshUser.trim())),
  )
  return (
    <form
      className="bold-add-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (preview) create.mutate()
        else review.mutate()
      }}
    >
      <div className="bold-add-main">
        <Appearance
          agents={agents}
          name={input.name}
          value={input.style}
          onChange={(style) => change({ style })}
        />
        <div className="bold-add-fields">
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
              value={input.id}
              onChange={(event) => {
                const id = agentIdInput(event.target.value)
                change({ id, name: id })
              }}
            />
          </label>
          <label>
            <span className="lab">What does it do?</span>
            <textarea
              className="field"
              required
              maxLength={2000}
              rows={3}
              value={input.role}
              onChange={(event) => change({ role: event.target.value })}
            />
          </label>
          <label>
            <span className="lab">Copy from</span>
            <select
              className="field"
              value={input.cloneFrom ?? ''}
              onChange={(event) => {
                const source = agents.find((agent) => agent.id === event.target.value)
                change({
                  cloneFrom: source?.id,
                  model: source?.model?.id ?? input.model,
                  provider: source?.model?.id ? undefined : input.provider,
                })
              }}
            >
              <option value="">Blank</option>
              {agents
                .filter((agent) => !agent.lifecycle || agent.lifecycle.state === 'ready')
                .map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    Copy from {agent.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="bold-add-grid2">
            <HermesModelPicker
              label="Model"
              required
              value={{ model: input.model, provider: input.provider ?? null }}
              onChange={(choice) =>
                change({ model: choice.model, provider: choice.provider ?? undefined })
              }
            />
            <WorksOnFields runs={runs} setRuns={setRuns} />
          </div>
          {preview && (
            <ReviewChanges
              preview={preview}
              input={input}
              confirmed={confirmed}
              setConfirmed={setConfirmed}
            />
          )}
          {(review.error || create.error) && (
            <p role="alert">{(review.error ?? create.error)?.message}</p>
          )}
        </div>
      </div>
      <footer className="bold-add-footer">
        <span className="small muted">
          It joins the team room. You can change everything later.
        </span>
        <button type="button" className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button
          className="btn primary coding-add-commit"
          data-protected="inline-flex"
          disabled={review.isPending || create.isPending || (preview ? !canCreate : false)}
        >
          {review.isPending
            ? 'Loading preview…'
            : create.isPending
              ? 'Adding…'
              : preview
                ? `Add ${input.name || 'agent'}`
                : 'Preview changes'}
        </button>
      </footer>
    </form>
  )
}

function ReviewChanges({
  preview,
  input,
  confirmed,
  setConfirmed,
}: {
  preview: NonNullable<ReturnType<typeof useAgentCreateDraft>['preview']>
  input: ReturnType<typeof useAgentCreateDraft>['input']
  confirmed: boolean
  setConfirmed: (checked: boolean) => void
}) {
  return (
    <section className="bold-add-review" aria-labelledby="bold-add-review-title">
      <h3 id="bold-add-review-title">Review changes</h3>
      <ul>
        {preview.effects.map((effect) => (
          <li key={effect}>{effect}</li>
        ))}
      </ul>
      {input.cloneFrom && (
        <>
          <dl>
            {Object.entries(preview.inherited).map(([key, values]) => (
              <div key={key}>
                <dt>
                  {
                    {
                      memories: 'Memories',
                      skills: 'Skills',
                      plugins: 'Plugins',
                      approvalSettings: 'Approval settings',
                      credentialsPresent: 'Credentials present (names only)',
                    }[key]
                  }
                </dt>
                <dd>{values.join(', ') || 'None'}</dd>
              </div>
            ))}
          </dl>
          <label className="check team-profile-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I’ve checked what this agent inherits.
          </label>
        </>
      )}
      {preview.blockers.map((blocker) => (
        <p role="alert" key={blocker}>
          {blocker}
        </p>
      ))}
    </section>
  )
}

function ImportProfilePanel({
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
  const finish = () => {
    if (finished.current) return
    finished.current = true
    onAdded({
      id: operation?.targetName ?? id,
      name: name || operation?.targetName || id,
      style,
      detail: 'Hermes agent, imported from an archive',
      another: false,
    })
  }
  const setup = useRunsOnSetup(operation?.state === 'completed', id, runs, finish)
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
          <button type="button" className="btn ghost" onClick={finish}>
            Continue without changing where it runs
          </button>
        )}
      </div>
    )

  if (!inspection)
    return (
      <div className="bold-add-form">
        <label className="bold-add-upload">
          <span className="lab">Profile export (.tar.gz, up to 200 MB)</span>
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

function CodingAgentPanel({
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
  const [created, setCreated] = useState<{ agent: CodingAgent; detail: string } | null>(null)
  const draft = useCodingAgentDraft(
    (agent: CodingAgent, detail: string) => setCreated({ agent, detail }),
    initial,
  )
  const {
    runtimes,
    runtime,
    chooseRuntime,
    id,
    setId,
    setName,
    role,
    setRole,
    workspace,
    setWorkspace,
    model,
    setModel,
    permission,
    setPermission,
    password,
    setPassword,
    acknowledged,
    setAcknowledged,
    style,
    setStyle,
    info,
    usable,
    unverified,
    needsAck,
    create,
  } = draft
  const [runs, setRuns] = useState<Runs>({
    backend: 'local',
    sshHost: '',
    sshUser: '',
    sshPort: '',
    sshKey: '',
  })
  const finished = useRef(false)
  const finish = () => {
    if (!created || finished.current) return
    finished.current = true
    onAdded({
      id: created.agent.id,
      name: created.agent.name,
      style: created.agent.style,
      detail: created.detail,
      another: false,
    })
  }
  const setup = useRunsOnSetup(created !== null, created?.agent.id ?? id, runs, finish)
  useEffect(() => {
    onBusy(create.isPending || created !== null)
  }, [create.isPending, created, onBusy])
  const blocked = Boolean(
    create.isPending ||
    !usable ||
    !id ||
    (needsAck && !acknowledged) ||
    unverified.includes(permission) ||
    (runs.backend === 'ssh' && (!runs.sshHost.trim() || !runs.sshUser.trim())),
  )
  if (created)
    return (
      <div className="bold-add-operation">
        <section className="team-card" aria-live="polite">
          <h2>Ready</h2>
          <p>{created.agent.name} was created as a coding agent.</p>
        </section>
        <RunsProgress setup={setup} />
        {setup.state === 'error' && (
          <button type="button" className="btn ghost" onClick={finish}>
            Continue without changing where it runs
          </button>
        )}
      </div>
    )
  return (
    <form
      className="bold-add-form"
      data-decision
      onSubmit={(event) => {
        event.preventDefault()
        if (!blocked) create.mutate()
      }}
    >
      <div className="bold-add-tool">
        <span className="lab">Which tool</span>
        <div className="bold-add-tools" role="radiogroup" aria-label="Which tool">
          {(runtimes.data ?? []).map((item) => (
            <button
              key={item.runtime}
              type="button"
              role="radio"
              aria-checked={runtime === item.runtime}
              className={runtime === item.runtime ? 'on' : undefined}
              onClick={() => chooseRuntime(item.runtime)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {!runtimes.data && <p className="small muted">Checking installed coding tools…</p>}
        {info && (
          <div className="bold-add-tool-state">
            <p className="coding-add-context" data-protected="block">
              {info.state === 'ready'
                ? `Installed · version ${info.version ?? 'unknown'} · tested by Score for ${info.testedVersions.join(', ')}. ${info.quota}`
                : info.state === 'untested_version'
                  ? `Installed · version ${info.version ?? 'unknown'}, which Score has not tested. ${info.quota}`
                  : (info.message ?? 'This coding tool is not ready.')}
            </p>
            {info.warning && (
              <p role="note" className="coding-add-context" data-protected="block">
                {info.warning}
              </p>
            )}
            <button
              type="button"
              className="link"
              disabled={runtimes.isFetching}
              onClick={() => void runtimes.refetch()}
            >
              {runtimes.isFetching ? 'Checking…' : 'Check version again'}
            </button>
          </div>
        )}
      </div>
      <div className="bold-add-main">
        <Appearance agents={agents} name={id} value={style} onChange={setStyle} />
        <div className="bold-add-fields">
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
              onChange={(event) => {
                const next = agentIdInput(event.target.value)
                setId(next)
                setName(next)
              }}
            />
          </label>
          <label>
            <span className="lab">What does it do?</span>
            <textarea
              className="field"
              maxLength={2000}
              rows={3}
              value={role}
              onChange={(event) => setRole(event.target.value)}
            />
          </label>
          <label>
            <span className="lab">Workspace folder (optional)</span>
            <input
              className="field"
              placeholder="~/score-workspaces/<name>"
              value={workspace}
              onChange={(event) => setWorkspace(event.target.value)}
            />
          </label>
          <WorksOnFields runs={runs} setRuns={setRuns} />
          <CodingModelPicker key={runtime} runtime={runtime} value={model} onChange={setModel} />
          <PermissionPicker
            value={permission}
            onChange={setPermission}
            name="bold-coding-permission"
            runtime={runtime}
            unverified={unverified}
          />
          {needsAck && (
            <label className="check coding-acknowledge" data-protected="any">
              <input
                type="checkbox"
                required
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              I understand {info?.label ?? 'this agent'} can read any file my user can, including
              secrets outside its workspace.
            </label>
          )}
          {permission === 'full' && (
            <label data-protected="any">
              <span className="lab">Security password</span>
              <input
                className="field"
                type="password"
                required
                autoComplete="off"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          )}
          <ReadAccessWarning runtime={runtime} permission={permission} />
          {create.error && <p role="alert">{create.error.message}</p>}
        </div>
      </div>
      <footer className="bold-add-footer">
        <span className="small muted">
          It joins the team room and uses your own login and plan. You can change everything later.
        </span>
        <button type="button" className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button
          className="btn primary coding-add-commit"
          data-protected="inline-flex"
          disabled={blocked}
        >
          {create.isPending ? 'Adding…' : 'Add coding agent'}
        </button>
      </footer>
    </form>
  )
}
