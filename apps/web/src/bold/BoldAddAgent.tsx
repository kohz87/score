import {
  PROFILE_IMPORT_MAX_BYTES,
  ShapeSchema,
  type AgentStyle,
  type AgentSummary,
  type RunsOn,
} from '@score/contract'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
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
import {
  addBlockReasons,
  availableStyle,
  colourChoices,
  saveRunsOn,
  type WorksOnChoice,
} from './bold-add-agent.ts'
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
  runs?: RunsOutcome
}

type RunsOutcome =
  { kind: 'saved'; runsOn: RunsOn } | { kind: 'local' } | { kind: 'failed'; reason: string }

const fromLabels: { value: From; label: string }[] = [
  { value: 'new', label: 'New agent' },
  { value: 'import', label: 'Bring in a Hermes profile' },
  { value: 'coding', label: 'A coding tool' },
]

const worksOnLabels: { value: WorksOnChoice['backend']; label: string }[] = [
  { value: 'local', label: 'This machine as you' },
  { value: 'docker', label: 'Docker (partly separated)' },
  { value: 'ssh', label: 'Another machine over SSH' },
]

const separatedLabels: Record<RunsOn['separated'], string> = {
  no: 'Not separated',
  partly: 'Partly separated',
  unknown: 'Separation not known',
}

const importMax = `${Math.round(PROFILE_IMPORT_MAX_BYTES / (1024 * 1024))} MB`

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
  const [askingClose, setAskingClose] = useState(false)
  const [added, setAdded] = useState<AddedAgent | null>(null)
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  const setWorking = useCallback((working: boolean) => {
    setBusy(working)
    if (!working) setAskingClose(false)
  }, [])
  const another = () => {
    setAdded(null)
    setWorking(false)
    setFrom('new')
  }
  const requestClose = () => {
    if (busy) setAskingClose(true)
    else close()
  }
  const onAdded = (agent: AddedAgent) => {
    setWorking(false)
    setAdded(agent)
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="bold-add-dialog"
      aria-label="Add an agent"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) close()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) close()
      }}
    >
      {added ? (
        <AddedView added={added} close={close} {...(added.another ? { another } : {})} />
      ) : (
        <>
          <header className="bold-add-head">
            <h2>Add an agent</h2>
            <button type="button" className="icon-btn" onClick={requestClose} aria-label="Close">
              <CloseIcon />
            </button>
          </header>
          {askingClose && (
            <div
              className="bold-add-confirm"
              role="alertdialog"
              aria-labelledby="bold-add-confirm-title"
              aria-describedby="bold-add-confirm-note"
              data-protected="block"
            >
              <b id="bold-add-confirm-title">Close while it’s still running?</b>
              <span id="bold-add-confirm-note" className="small muted">
                Score is still working. An upload is discarded; setup already started keeps going in
                the background.
              </span>
              <div className="bold-add-confirm-actions">
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => setAskingClose(false)}
                  autoFocus
                >
                  Keep waiting
                </button>
                <button type="button" className="btn sm primary" onClick={close}>
                  Close anyway
                </button>
              </div>
            </div>
          )}
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
              close={requestClose}
              onAdded={onAdded}
              onBusy={setWorking}
            />
          )}
          {from === 'import' && (
            <ImportProfilePanel
              agents={agents}
              close={requestClose}
              onAdded={onAdded}
              onBusy={setWorking}
            />
          )}
          {from === 'coding' && (
            <CodingAgentPanel
              agents={agents}
              close={requestClose}
              onAdded={onAdded}
              onBusy={setWorking}
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
      <AgentGlyph agent={{ id: added.id, name: added.name, style: added.style }} size="lg" />
      <h2>{added.name} joined the team</h2>
      <p className="muted">{added.detail}</p>
      {added.runs && <JoinedRuns id={added.id} runs={added.runs} close={close} />}
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

function JoinedRuns({ id, runs, close }: { id: string; runs: RunsOutcome; close: () => void }) {
  if (runs.kind === 'failed')
    return (
      <div className="bold-add-joined-runs" data-protected="block">
        <p>Runs on this machine as you: {runs.reason}</p>
        <WhereItWorksLink id={id} close={close} />
      </div>
    )
  if (runs.kind === 'local')
    return (
      <div className="bold-add-joined-runs" data-protected="block">
        <p>Runs on this machine as you.</p>
        <WhereItWorksLink id={id} close={close} />
      </div>
    )
  const backend =
    runs.runsOn.backend === 'docker'
      ? 'Docker'
      : runs.runsOn.backend === 'ssh'
        ? 'Another machine over SSH'
        : runs.runsOn.backend === 'local'
          ? 'This machine as you'
          : `Another backend (${runs.runsOn.raw ?? 'unknown'})`
  return (
    <div className="bold-add-joined-runs" data-protected="block">
      <p>
        <b>
          {backend} · {separatedLabels[runs.runsOn.separated]}
        </b>
        {runs.runsOn.notes[0] ? ` — ${runs.runsOn.notes[0]}` : null}
      </p>
      <WhereItWorksLink id={id} close={close} />
    </div>
  )
}

function WhereItWorksLink({ id, close }: { id: string; close: () => void }) {
  return (
    <Link className="link" to={`/b/team/${encodeURIComponent(id)}#agent-where`} onClick={close}>
      Where it works
    </Link>
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
  const chosen = colours.find((choice) => choice.colour === value.color.toLowerCase())
  const firstFree = colours.find((choice) => choice.takenBy === null)
  useEffect(() => {
    // The dialog can open before the roster has loaded; once it does, never keep a colour that is already taken.
    if (firstFree && (!chosen || chosen.takenBy !== null))
      onChange({ ...value, color: firstFree.colour })
  }, [chosen, firstFree, onChange, value])
  const group = useId()
  return (
    <div className="bold-add-appearance">
      <div className="bold-add-preview">
        <AgentGlyph
          agent={{ id: 'new-agent', name: name || 'New agent', style: value }}
          size="lg"
          describeShape
        />
      </div>
      <div className="bold-add-shapes" role="radiogroup" aria-label="Shape">
        {ShapeSchema.options.map((shape) => {
          const selected = value.shape === shape
          const label = shapeLabel(shape)
          return (
            <label key={shape} className={selected ? 'on' : undefined}>
              <input
                type="radio"
                name={`${group}-shape`}
                value={shape}
                checked={selected}
                aria-label={label}
                onChange={() => onChange({ ...value, shape })}
              />
              <AgentGlyph
                agent={{ id: `shape-${shape}`, name: label, style: { ...value, shape } }}
                size="sm"
                bare
                decorative
              />
            </label>
          )
        })}
      </div>
      <div className="bold-add-colours" role="radiogroup" aria-label="Colour">
        {colours.map(({ colour, takenBy }) => {
          const selected = value.color.toLowerCase() === colour
          return (
            <label
              key={colour}
              className={selected ? 'on' : undefined}
              style={{ background: colour }}
            >
              <input
                type="radio"
                name={`${group}-colour`}
                value={colour}
                checked={selected}
                aria-label={`Colour ${colour}${takenBy ? `, used by ${takenBy}` : ''}`}
                data-colour={colour}
                disabled={takenBy !== null}
                onChange={() => onChange({ ...value, color: colour })}
              />
            </label>
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

function useRunsOnSetup(
  ready: boolean,
  agentId: string,
  runs: Runs,
  onReady: (result: RunsOn | null) => void,
) {
  const [state, setState] = useState<'idle' | 'saving' | 'error' | 'ready'>('idle')
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)
  const saveRef = useRef<() => Promise<void>>(async () => undefined)
  const save = async () => {
    setState('saving')
    setError(null)
    try {
      const choice = runsChoice(runs)
      const result = choice.backend === 'local' ? null : await saveRunsOn(agentId, choice)
      setState('ready')
      onReady(result)
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
      <div className="bold-add-error" role="alert" data-protected="block">
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
  const finish = (runsOutcome: RunsOutcome) => {
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
      runs: runsOutcome,
    })
  }
  const setup = useRunsOnSetup(operation?.state === 'completed', input.id, runs, (result) =>
    finish(result ? { kind: 'saved', runsOn: result } : { kind: 'local' }),
  )
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

  const canCreate = Boolean(
    preview &&
    preview.blockers.length === 0 &&
    (!input.cloneFrom || confirmed) &&
    (runs.backend !== 'ssh' || (runs.sshHost.trim() && runs.sshUser.trim())),
  )
  const reasons = preview ? addBlockReasons(preview.blockers, input, confirmed, runs) : []
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
      {reasons.length > 0 && (
        <div className="bold-add-blockers" role="alert" data-protected="block">
          <strong>Why “Add” is off</strong>
          <ul>
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
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
  const draft = useCodingAgentDraft(
    (agent, detail) =>
      onAdded({
        id: agent.id,
        name: agent.name,
        style: agent.style,
        detail,
        another: false,
      }),
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
  useEffect(() => {
    onBusy(create.isPending)
  }, [create.isPending, onBusy])
  const blocked = Boolean(
    create.isPending ||
    !usable ||
    !id ||
    (needsAck && !acknowledged) ||
    unverified.includes(permission),
  )
  const group = useId()
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
            <label key={item.runtime} className={runtime === item.runtime ? 'on' : undefined}>
              <input
                type="radio"
                name={`${group}-tool`}
                value={item.runtime}
                checked={runtime === item.runtime}
                onChange={() => chooseRuntime(item.runtime)}
              />
              <span>{item.label}</span>
            </label>
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
          <p className="small muted">Runs on this machine as you.</p>
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
