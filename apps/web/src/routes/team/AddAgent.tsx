import {
  AgentOperationSchema,
  AgentPreviewSchema,
  ShapeSchema,
  type AgentCreateInput,
  type AgentOperation,
  type AgentPreview,
  type AgentSummary,
} from '@score/contract'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { apiFetch } from '../../data/api.ts'
import { ProfileOperation, useProfileOperation } from './ProfileOperation.tsx'
import { newId } from '../../data/ids.ts'

export function AddAgent({ agents }: { agents: AgentSummary[] }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={trigger} type="button" className="team-add-agent" onClick={() => setOpen(true)}>
        Add agent
      </button>
      {open && (
        <AddAgentDialog
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
function AddAgentDialog({ agents, close }: { agents: AgentSummary[]; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [input, setInput] = useState<AgentCreateInput>({
    id: '',
    name: '',
    role: '',
    model: '',
    style: { color: '#19C39A', shape: 'triangle' },
  })
  const [preview, setPreview] = useState<AgentPreview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [accepted, setAccepted] = useState<AgentOperation | null>(null)
  const status = useProfileOperation(accepted?.id ?? null)
  const operation = status.data ?? accepted
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  const review = useMutation({
    mutationFn: async () =>
      AgentPreviewSchema.parse(
        await apiFetch('agents/preview', {
          method: 'POST',
          body: JSON.stringify({ kind: 'create', ...input }),
        }),
      ),
    onSuccess: setPreview,
  })
  const create = useMutation({
    mutationFn: async () =>
      AgentOperationSchema.parse(
        await apiFetch('agents', {
          method: 'POST',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify({
            ...input,
            previewHash: preview!.hash,
            confirmInheritance: confirmed,
          }),
        }),
      ),
    onSuccess: setAccepted,
    onError: () => {
      setPreview(null)
      setConfirmed(false)
    },
  })
  const change = (patch: Partial<AgentCreateInput>) => {
    setInput((current) => ({ ...current, ...patch }))
    setPreview(null)
    setConfirmed(false)
    review.reset()
    create.reset()
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="team-profile-dialog"
      aria-labelledby="add-agent-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="team-card-heading">
        <h2 id="add-agent-title">Add agent</h2>
        <button type="button" className="team-pill-button" onClick={close}>
          Close
        </button>
      </div>
      {operation ? (
        <>
          <ProfileOperation operation={operation} />
          {status.isError && (
            <p role="alert">
              Could not refresh progress.{' '}
              <button onClick={() => void status.refetch()}>Try again</button>
            </p>
          )}
          {operation.state === 'completed' && (
            <Link to={`/team/${encodeURIComponent(operation.targetName)}`} onClick={close}>
              View agent
            </Link>
          )}
        </>
      ) : (
        <form
          className="team-routine-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (preview) create.mutate()
            else review.mutate()
          }}
        >
          <label>
            Profile name
            <input
              autoFocus
              required
              pattern="[a-z0-9][a-z0-9_-]{0,63}"
              maxLength={64}
              value={input.id}
              onChange={(event) => change({ id: event.target.value, name: event.target.value })}
            />
          </label>
          <label>
            Role / description
            <textarea
              required
              maxLength={2000}
              value={input.role}
              onChange={(event) => change({ role: event.target.value })}
            />
          </label>
          <label>
            Start from
            <select
              value={input.cloneFrom ?? ''}
              onChange={(event) => {
                const source = agents.find((agent) => agent.id === event.target.value)
                change({ cloneFrom: source?.id, model: source?.model?.id ?? input.model })
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
          <label>
            Model
            <input
              required
              maxLength={256}
              value={input.model}
              onChange={(event) => change({ model: event.target.value })}
              list="profile-models"
            />
          </label>
          <datalist id="profile-models">
            {[...new Set(agents.map((agent) => agent.model?.id).filter(Boolean))].map((model) => (
              <option key={model} value={model!} />
            ))}
          </datalist>
          <div className="team-profile-appearance">
            <AgentGlyph
              agent={{ id: input.id || 'new', name: input.id || 'New agent', style: input.style }}
              describeShape
              contrast="high"
            />
            <label>
              Color
              <input
                type="color"
                value={input.style.color}
                onChange={(event) =>
                  change({ style: { ...input.style, color: event.target.value } })
                }
              />
            </label>
            <label>
              Shape
              <select
                aria-label="Shape"
                value={input.style.shape}
                onChange={(event) =>
                  change({
                    style: { ...input.style, shape: ShapeSchema.parse(event.target.value) },
                  })
                }
              >
                {ShapeSchema.options.map((shape) => (
                  <option key={shape}>{shape}</option>
                ))}
              </select>
            </label>
          </div>
          {preview && (
            <section className="team-card">
              <h3>Review changes</h3>
              <ul>
                {preview.effects.map((effect) => (
                  <li key={effect}>{effect}</li>
                ))}
              </ul>
              {input.cloneFrom && (
                <>
                  <dl className="team-facts">
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
                  <label className="team-profile-confirm">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    I confirm the inherited data and capabilities.
                  </label>
                </>
              )}
              {preview.blockers.map((blocker) => (
                <p role="alert" key={blocker}>
                  {blocker}
                </p>
              ))}
            </section>
          )}
          {(review.error || create.error) && (
            <p role="alert">{(review.error ?? create.error)?.message}</p>
          )}
          <div className="team-file-actions">
            <button
              className="team-primary"
              disabled={
                review.isPending ||
                create.isPending ||
                Boolean(preview && (preview.blockers.length || (input.cloneFrom && !confirmed)))
              }
            >
              {review.isPending
                ? 'Loading preview…'
                : create.isPending
                  ? 'Creating…'
                  : preview
                    ? 'Create agent'
                    : 'Preview changes'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  )
}
