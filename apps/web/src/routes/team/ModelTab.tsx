import { useState, type FormEvent } from 'react'
import type { AgentDetail } from '@score/contract'
import { ModelPicker, type ModelChoice } from '../../components/ModelPicker.tsx'
import { useModelAction } from './agent-tab-queries.ts'
import { tabFailure } from './tab-errors.ts'

export function ModelTab({ agent }: { agent: AgentDetail }) {
  const change = useModelAction(agent.id)
  const [choice, setChoice] = useState<ModelChoice>({ model: '', provider: null })
  const [notice, setNotice] = useState('')

  function submit(event: FormEvent) {
    event.preventDefault()
    const next = choice.model.trim()
    const via = choice.provider
    setNotice('')
    change.mutate(
      { model: next, ...(via ? { provider: via } : {}) },
      {
        onSuccess: () => {
          setNotice(`Model changed to ${next}.`)
          setChoice({ model: '', provider: null })
        },
      },
    )
  }
  return (
    <section className="team-card" aria-labelledby="team-model-heading">
      <h2 id="team-model-heading">Model</h2>
      <p className="team-model-name">{agent.model?.label ?? 'Model unavailable'}</p>
      {agent.model && (
        <p className="team-muted-strong">
          {agent.model.via ? `Through ${agent.model.via}.` : 'Provider unavailable.'}
          {agent.model.fallback
            ? ` Falls back to ${agent.model.fallback} if it's unavailable.`
            : ' No fallback configured.'}
        </p>
      )}
      <form className="team-routine-form" aria-label="Change model" onSubmit={submit}>
        <ModelPicker label="Model" required value={choice} onChange={setChoice} maxLength={200} />
        {change.isError && <p role="alert">{tabFailure(change.error, 'change the model')}</p>}
        <div className="team-style-actions">
          <button type="submit" className="team-primary" disabled={change.isPending}>
            {change.isPending ? 'Saving…' : 'Change model'}
          </button>
        </div>
      </form>
      <p className="team-muted" role="status">
        {notice}
      </p>
    </section>
  )
}
