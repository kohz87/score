import { useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router'
import type { AgentDetail } from '@score/contract'
import { ModelPicker, type ModelChoice } from '../../components/ModelPicker.tsx'
import { ApiError } from '../../data/api.ts'
import { useModelAction } from '../../routes/team/agent-tab-queries.ts'
import { tabFailure } from '../../routes/team/tab-errors.ts'

const HERMES_DEFAULT_VIA = 'Hermes configuration'

/** The Model row's form: the picker that changes the agent's model (moved here from the Team Model tab, unchanged). */
export function ModelChangeForm({ agent }: { agent: AgentDetail }) {
  const change = useModelAction(agent.id)
  const inBold = useLocation().pathname.startsWith('/b/')
  // The picker starts on what the agent uses now; once the person edits it, their draft wins until a save lands.
  const current: ModelChoice = {
    model: agent.model?.id ?? '',
    provider: agent.model && agent.model.via !== HERMES_DEFAULT_VIA ? agent.model.via : null,
  }
  const [draft, setDraft] = useState<ModelChoice | null>(null)
  const [saved, setSaved] = useState('')
  const choice = draft ?? current

  function save(next: ModelChoice) {
    const model = next.model.trim()
    setSaved('')
    change.mutate(
      { model, ...(next.provider ? { provider: next.provider } : {}) },
      {
        onSuccess: () => {
          setSaved(model)
          setDraft(null)
        },
      },
    )
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    save(choice)
  }
  return (
    <>
      <form className="team-routine-form" aria-label="Change model" onSubmit={submit}>
        <ModelPicker
          label="Model"
          required
          value={choice}
          onChange={setDraft}
          maxLength={200}
          agentId={agent.id}
        />
        {current.model && (
          <p className="team-muted">
            Current: {current.model}
            {current.provider ? ` (through ${current.provider})` : ''}
          </p>
        )}
        {change.isError && (
          <p role="alert">
            {tabFailure(change.error, 'change the model')}{' '}
            {change.error instanceof ApiError && change.error.code === 'needs_key' && (
              <Link to={inBold ? '/b/settings/connections' : '/settings'}>Open Connections</Link>
            )}{' '}
            <button type="button" className="team-pill-button" onClick={() => save(choice)}>
              Retry
            </button>
          </p>
        )}
        <div className="team-style-actions">
          <button type="submit" className="team-primary" disabled={change.isPending}>
            {change.isPending ? 'Saving…' : 'Change model'}
          </button>
        </div>
        {change.isPending && (
          <p className="team-muted">Saving to Hermes. This can take several seconds.</p>
        )}
      </form>
      <p className="team-muted" role="status">
        {saved ? `Saved: ${saved}` : ''}
      </p>
    </>
  )
}
