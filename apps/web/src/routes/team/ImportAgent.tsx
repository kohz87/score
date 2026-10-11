import {
  AgentOperationSchema,
  ImportInspectionSchema,
  PROFILE_IMPORT_MAX_BYTES,
  ShapeSchema,
  type AgentOperation,
  type AgentStyle,
  type AgentSummary,
  type ImportInspection,
} from '@score/contract'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { ProfileOperation, useProfileOperation } from './ProfileOperation.tsx'

const MiB = 1024 * 1024
const size = (bytes: number) =>
  bytes >= MiB ? `${(bytes / MiB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function ImportAgent({ agents }: { agents: AgentSummary[] }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={trigger} type="button" className="team-add-agent" onClick={() => setOpen(true)}>
        Import agent
      </button>
      {open && (
        <ImportAgentDialog
          agents={agents}
          close={() => {
            setOpen(false)
            trigger.current?.focus()
          }}
        />
      )}
    </>
  )
}

function List({ label, values }: { label: string; values: string[] }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{values.length ? values.join(', ') : 'None'}</dd>
    </div>
  )
}

function ImportAgentDialog({ agents, close }: { agents: AgentSummary[]; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [inspection, setInspection] = useState<ImportInspection | null>(null)
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [style, setStyle] = useState<AgentStyle>({ color: '#19C39A', shape: 'triangle' })
  const [credentialsOk, setCredentialsOk] = useState(false)
  const [accepted, setAccepted] = useState<AgentOperation | null>(null)
  const status = useProfileOperation(accepted?.id ?? null)
  const operation = status.data ?? accepted
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > PROFILE_IMPORT_MAX_BYTES)
        throw new Error('The archive is larger than 200 MB.')
      return ImportInspectionSchema.parse(
        await apiFetch('agents/imports', {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: file,
        }),
      )
    },
    onSuccess: (result) => {
      setInspection(result)
      setId(result.suggestedId ?? '')
      setName(result.suggestedId ?? '')
      setRole(result.description ?? '')
    },
  })
  const start = useMutation({
    mutationFn: async () =>
      AgentOperationSchema.parse(
        await apiFetch('agents/import', {
          method: 'POST',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify({
            uploadId: inspection!.uploadId,
            id,
            name: name || id,
            role,
            style,
            ...(inspection!.credentialFiles.length ? { confirmCredentials: credentialsOk } : {}),
          }),
        }),
      ),
    onSuccess: setAccepted,
  })
  // Leaving the preview drops the stored upload; once an import runs, the server owns it.
  const leave = () => {
    if (inspection && !accepted)
      void apiFetch(`agents/imports/${inspection.uploadId}`, { method: 'DELETE' }).catch(() => {})
    close()
  }

  const taken = agents.some((agent) => agent.id === id)
  const idValid = ID_PATTERN.test(id) && id !== 'default'
  const needsCredentialOk = Boolean(inspection?.credentialFiles.length) && !credentialsOk
  const blocked = !idValid || taken || !role.trim() || needsCredentialOk || start.isPending

  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="team-profile-dialog"
      aria-labelledby="import-agent-title"
      onCancel={(event) => {
        event.preventDefault()
        leave()
      }}
    >
      <div className="team-card-heading">
        <h2 id="import-agent-title">Import agent</h2>
        <button type="button" className="team-pill-button" onClick={leave}>
          {operation ? 'Close' : 'Cancel'}
        </button>
      </div>
      {operation ? (
        <>
          <ProfileOperation operation={operation} />
          {status.isError && (
            <p role="alert">
              Couldn’t refresh progress.{' '}
              <button onClick={() => void status.refetch()}>Try again</button>
            </p>
          )}
          {operation.state === 'completed' && (
            <Link to={`/team/${encodeURIComponent(operation.targetName)}`} onClick={close}>
              View agent
            </Link>
          )}
        </>
      ) : !inspection ? (
        <div className="team-routine-form">
          <p>
            Choose an archive made by <code>hermes profile export</code> (a .tar.gz, up to 200 MB).
            Score reads what is inside without unpacking it into your Hermes profiles.
          </p>
          <label>
            Archive
            <input
              type="file"
              accept=".gz,.tgz,application/gzip,application/x-gzip"
              disabled={upload.isPending}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) upload.mutate(file)
              }}
            />
          </label>
          {upload.isPending && <p aria-live="polite">Reading the archive…</p>}
          {upload.error && <p role="alert">{upload.error.message}</p>}
        </div>
      ) : (
        <form
          className="team-routine-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (!blocked) start.mutate()
          }}
        >
          <section className="team-card">
            <h3>In this archive</h3>
            <dl className="team-facts">
              <div>
                <dt>Exported as</dt>
                <dd>{inspection.archiveRoot}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{inspection.model ?? 'Not set in the archive'}</dd>
              </div>
              <List label="Skills" values={inspection.skills} />
              <List label="Plugins" values={inspection.plugins} />
              <div>
                <dt>Memory</dt>
                <dd>{size(inspection.memoryBytes)}</dd>
              </div>
              <div>
                <dt>Hermes config version</dt>
                <dd>{inspection.configVersion ?? 'Unknown'}</dd>
              </div>
              <div>
                <dt>Contents</dt>
                <dd>
                  {inspection.fileCount} files, {size(inspection.totalBytes)} unpacked
                </dd>
              </div>
              <List label="Credential files (names only)" values={inspection.credentialFiles} />
            </dl>
            {inspection.warnings.map((warning) => (
              <p role="alert" key={warning}>
                {warning}
              </p>
            ))}
            <p>
              Hermes also adds a small launcher script for the new profile in{' '}
              <code>~/.local/bin</code>.
            </p>
          </section>
          <label>
            New agent id
            <input
              autoFocus
              required
              pattern="[a-z0-9][a-z0-9_\-]{0,63}"
              maxLength={64}
              value={id}
              aria-invalid={taken || (id !== '' && !idValid)}
              onChange={(event) => {
                setId(event.target.value)
                setName(event.target.value)
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
            Role or description
            <textarea
              required
              maxLength={2000}
              value={role}
              onChange={(event) => setRole(event.target.value)}
            />
          </label>
          <div className="team-profile-appearance">
            <AgentGlyph
              agent={{ id: id || 'new', name: id || 'New agent', style }}
              describeShape
              contrast="high"
            />
            <label>
              Colour
              <input
                type="color"
                value={style.color}
                onChange={(event) => setStyle({ ...style, color: event.target.value })}
              />
            </label>
            <label>
              Shape
              <select
                aria-label="Shape"
                value={style.shape}
                onChange={(event) =>
                  setStyle({ ...style, shape: ShapeSchema.parse(event.target.value) })
                }
              >
                {ShapeSchema.options.map((shape) => (
                  <option key={shape}>{shape}</option>
                ))}
              </select>
            </label>
          </div>
          {inspection.credentialFiles.length > 0 && (
            <label className="team-profile-confirm">
              <input
                type="checkbox"
                checked={credentialsOk}
                onChange={(event) => setCredentialsOk(event.target.checked)}
              />
              I know the archive contains credential files and want them copied into the new agent.
            </label>
          )}
          {start.error && <p role="alert">{start.error.message}</p>}
          <div className="team-file-actions">
            <button className="team-primary" disabled={blocked}>
              {start.isPending ? 'Starting…' : 'Import agent'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  )
}
