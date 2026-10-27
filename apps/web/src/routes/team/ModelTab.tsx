import { useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router'
import type { AgentDetail } from '@score/contract'
import { ModelPicker, type ModelChoice } from '../../components/ModelPicker.tsx'
import { AliasEditor } from '../../components/model-settings/AliasEditor.tsx'
import { EffortSetting } from '../../components/model-settings/EffortSetting.tsx'
import { FallbackChain } from '../../components/model-settings/FallbackChain.tsx'
import { SpeechModels } from '../../components/model-settings/SpeechModels.tsx'
import { useModelSettings } from './model-settings-queries.ts'
import { useModelAction } from './agent-tab-queries.ts'
import { ApiError } from '../../data/api.ts'
import { tabFailure } from './tab-errors.ts'

const HERMES_DEFAULT_VIA = 'Hermes configuration'

export function ModelTab({ agent }: { agent: AgentDetail }) {
  const change = useModelAction(agent.id)
  const settings = useModelSettings(agent.id)
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
    <section className="team-card" aria-labelledby="team-model-heading">
      <h2 id="team-model-heading">Model</h2>
      <p className="team-model-name">{agent.model?.label ?? 'Model unavailable'}</p>
      {agent.model && (
        <p className="team-muted-strong">
          {agent.model.via ? `Through ${agent.model.via}.` : 'Provider unavailable.'}
          {agent.model.fallback
            ? ` Falls back to ${agent.model.fallback} if it’s unavailable.`
            : ' No fallback configured.'}
        </p>
      )}
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
      {settings.isPending && <p role="status">Loading fallbacks, aliases and speech models…</p>}
      {settings.isError && (
        <p role="alert">
          Couldn’t read this agent’s fallback, alias and speech settings from Hermes.
        </p>
      )}
      {settings.data && (
        <>
          <EffortSetting
            key={settings.data.effort ?? ''}
            agentId={agent.id}
            settings={settings.data}
          />
          <FallbackChain
            key={JSON.stringify(settings.data.fallbacks)}
            agentId={agent.id}
            settings={settings.data}
          />
          <AliasEditor agentId={agent.id} />
          <SpeechModels
            key={JSON.stringify(settings.data.speech)}
            agentId={agent.id}
            settings={settings.data}
          />
        </>
      )}
    </section>
  )
}
