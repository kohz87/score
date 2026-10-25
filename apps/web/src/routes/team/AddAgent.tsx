import { type AgentCreateInput, type AgentSummary } from '@score/contract'
import { useEffect, useRef, useState } from 'react'
import { AGENT_ID_PATTERN, agentIdInput } from './agent-id.ts'
import { AgentAdded } from './AgentAdded.tsx'
import { ModelPicker } from '../../components/ModelPicker.tsx'
import { AgentAppearanceFields } from './AgentAppearanceFields.tsx'
import { ProfileOperation } from './ProfileOperation.tsx'
import { AddCodingAgentForm } from './CodingAgent.tsx'
import { useAgentCreateDraft } from './use-agent-create.ts'

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
type AgentAddedInfo = { id: string; name: string; style: AgentCreateInput['style'] }

function AddAgentDialog({ agents, close }: { agents: AgentSummary[]; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [kind, setKind] = useState<'hermes' | 'coding'>('hermes')
  const [added, setAdded] = useState<{ agent: AgentAddedInfo; detail: string } | null>(null)
  const {
    input,
    preview,
    confirmed,
    operation,
    status,
    review,
    create,
    change,
    another: resetDraft,
    setConfirmed,
    reuseConfirmed,
    setReuseConfirmed,
  } = useAgentCreateDraft()
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  const another = () => {
    resetDraft()
    setAdded(null)
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="team-profile-dialog"
      aria-label="Add agent"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      {added ? (
        <AgentAdded agent={added.agent} detail={added.detail} onAnother={another} onClose={close} />
      ) : operation?.state === 'completed' ? (
        <AgentAdded
          agent={{
            id: operation.targetName,
            name: input.name || operation.targetName,
            style: input.style,
          }}
          detail={['Hermes agent', input.model].filter(Boolean).join(' · ')}
          onAnother={another}
          onClose={close}
        />
      ) : (
        <>
          <div className="team-card-heading">
            <h2 id="add-agent-title">Add agent</h2>
            <button type="button" className="team-pill-button" onClick={close}>
              Close
            </button>
          </div>
          {!operation && (
            <fieldset className="team-add-kind">
              <legend>Kind of agent</legend>
              <label>
                <input
                  type="radio"
                  name="agent-kind"
                  checked={kind === 'hermes'}
                  onChange={() => setKind('hermes')}
                />{' '}
                Hermes agent
              </label>
              <label>
                <input
                  type="radio"
                  name="agent-kind"
                  checked={kind === 'coding'}
                  onChange={() => setKind('coding')}
                />{' '}
                Coding agent (Claude Code, Codex, Antigravity)
              </label>
            </fieldset>
          )}
          {kind === 'coding' && !operation ? (
            <AddCodingAgentForm onAdded={(agent, detail) => setAdded({ agent, detail })} />
          ) : operation ? (
            <>
              <ProfileOperation operation={operation} />
              {status.isError && (
                <p role="alert">
                  Couldn’t refresh progress.{' '}
                  <button onClick={() => void status.refetch()}>Try again</button>
                </p>
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
                Agent name (lowercase letters, digits, - and _)
                <input
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
                Role or description
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
              <ModelPicker
                label="Model"
                required
                value={{ model: input.model, provider: input.provider ?? null }}
                onChange={(choice) => {
                  change({ model: choice.model, provider: choice.provider ?? undefined })
                }}
              />
              <AgentAppearanceFields
                value={input.style}
                onChange={(style) => change({ style })}
                preview={{ id: input.id || 'new', name: input.id || 'New agent' }}
              />
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
                        I’ve checked what this agent inherits.
                      </label>
                    </>
                  )}
                  {preview.reusesName && (
                    <label className="team-profile-confirm" data-protected="block">
                      <input
                        type="checkbox"
                        checked={reuseConfirmed}
                        onChange={(event) => setReuseConfirmed(event.target.checked)}
                      />
                      Use the name {input.id} again. The removed agent’s messages, runs and reports
                      keep it.
                    </label>
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
                    Boolean(
                      preview &&
                      (preview.blockers.length ||
                        (input.cloneFrom && !confirmed) ||
                        (preview.reusesName && !reuseConfirmed)),
                    )
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
        </>
      )}
    </dialog>
  )
}
