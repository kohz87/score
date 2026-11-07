import type { AgentSummary } from '@score/contract'
import { useEffect, useRef, useState } from 'react'
import { ModelPicker as HermesModelPicker } from '../components/ModelPicker.tsx'
import { AGENT_ID_PATTERN, agentIdInput } from '../routes/team/agent-id.ts'
import { ProfileOperation } from '../routes/team/ProfileOperation.tsx'
import { emptyAgentInput, useAgentCreateDraft } from '../routes/team/use-agent-create.ts'
import { addBlockReasons, availableStyle } from './bold-add-agent.ts'
import { Appearance } from './BoldAddAgentAppearance.tsx'
import { RunsProgress, WorksOnFields, useRunsOnSetup } from './BoldAddAgentRuns.tsx'
import type { AddedAgent, Runs, RunsOutcome } from './bold-add-agent-types.ts'

export function NewAgentPanel({
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
  const { reuseConfirmed, setReuseConfirmed } = draft
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
    (!preview.reusesName || reuseConfirmed) &&
    (runs.backend !== 'ssh' || (runs.sshHost.trim() && runs.sshUser.trim())),
  )
  const reasons = preview
    ? addBlockReasons(preview.blockers, input, confirmed, runs, {
        id: input.id,
        needed: preview.reusesName === true,
        confirmed: reuseConfirmed,
      })
    : []
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
              reuseConfirmed={reuseConfirmed}
              setReuseConfirmed={setReuseConfirmed}
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
  reuseConfirmed,
  setReuseConfirmed,
}: {
  preview: NonNullable<ReturnType<typeof useAgentCreateDraft>['preview']>
  input: ReturnType<typeof useAgentCreateDraft>['input']
  confirmed: boolean
  setConfirmed: (checked: boolean) => void
  reuseConfirmed: boolean
  setReuseConfirmed: (checked: boolean) => void
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
      {preview.reusesName && (
        <label className="check team-profile-confirm bold-add-reuse" data-protected="block">
          <input
            type="checkbox"
            checked={reuseConfirmed}
            onChange={(event) => setReuseConfirmed(event.target.checked)}
          />
          Use the name {input.id} again. The removed agent’s messages, runs and reports keep it.
        </label>
      )}
    </section>
  )
}
