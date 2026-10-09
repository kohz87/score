import { useState } from 'react'
import { ModelsResponseSchema, type AgentSummary, type ModelRef } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { AliasEditor } from '../../components/model-settings/AliasEditor.tsx'
import '../../components/model-settings/model-settings.css'
import { apiFetch } from '../../data/api.ts'
import { useModelVisibility, useSaveModelVisibility } from '../team/model-settings-queries.ts'

const keyOf = (ref: ModelRef) => `${ref.provider}\0${ref.model}`

/** Settings › Models and keys: which models the pickers list by default, and the aliases of one agent. */
export function ModelListSection({ agents }: { agents: AgentSummary[] }) {
  return (
    <section className="settings-card" aria-labelledby="settings-model-list">
      <div>
        <h2 id="settings-model-list">Models in pickers</h2>
        <p className="settings-muted-strong">
          Hermes knows hundreds of models. Choose the ones the model pickers should list; the rest
          stay one click away under &ldquo;Show all&rdquo;.
        </p>
      </div>
      <ChosenModels />
      <AgentAliases agents={agents} />
    </section>
  )
}

function ChosenModels() {
  const saved = useModelVisibility()
  const save = useSaveModelVisibility()
  const [q, setQ] = useState('')
  const [draft, setDraft] = useState<ModelRef[] | null>(null)
  const models = useQuery({
    queryKey: ['models', q.trim(), null, true],
    queryFn: async () =>
      ModelsResponseSchema.parse(
        await apiFetch(`models?all=1${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`),
      ).items,
    retry: false,
  })
  const chosen = draft ?? saved.data ?? []
  const chosenKeys = new Set(chosen.map(keyOf))
  const changed =
    draft !== null &&
    JSON.stringify([...chosen.map(keyOf)].sort()) !==
      JSON.stringify([...(saved.data ?? []).map(keyOf)].sort())
  function toggle(ref: ModelRef) {
    setDraft(
      chosenKeys.has(keyOf(ref))
        ? chosen.filter((item) => keyOf(item) !== keyOf(ref))
        : [...chosen, ref],
    )
  }
  return (
    <div className="ms-block" role="group" aria-labelledby="settings-chosen-models">
      <h3 id="settings-chosen-models">Chosen models</h3>
      <p className="ms-note" role="status">
        {saved.isPending
          ? 'Loading…'
          : chosen.length
            ? `${chosen.length} chosen. Pickers list only these.`
            : 'None chosen: pickers list every model.'}
      </p>
      <label className="ms-field">
        Search models
        <input
          value={q}
          maxLength={100}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
        />
      </label>
      {models.isError && <p role="alert">Could not load the models.</p>}
      <ul className="ms-list ms-chooser" aria-label="Models">
        {(models.data ?? []).map((option) => (
          <li key={keyOf(option)} className="ms-row">
            <label className="ms-check">
              <input
                type="checkbox"
                checked={chosenKeys.has(keyOf(option))}
                onChange={() => toggle({ provider: option.provider, model: option.model })}
              />
              <span className="ms-row-name">{option.model}</span>
            </label>
            <span className="ms-row-detail">{option.providerLabel}</span>
          </li>
        ))}
      </ul>
      <div className="ms-actions">
        <button
          type="button"
          className="ms-button"
          data-primary=""
          disabled={!changed || save.isPending}
          onClick={() => save.mutate(chosen, { onSuccess: () => setDraft(null) })}
        >
          {save.isPending ? 'Saving…' : 'Save chosen models'}
        </button>
        <button
          type="button"
          className="ms-button"
          disabled={chosen.length === 0 || save.isPending}
          onClick={() => setDraft([])}
        >
          Clear (show all)
        </button>
      </div>
      {save.isError && <p role="alert">Could not save the list. Please try again.</p>}
    </div>
  )
}

function AgentAliases({ agents }: { agents: AgentSummary[] }) {
  const [picked, setPicked] = useState('')
  const agentId = picked || agents[0]?.id
  if (!agentId) return null
  return (
    <div className="ms-block" role="group" aria-label="Aliases by agent">
      <label className="ms-field">
        Aliases of
        <select value={agentId} onChange={(event) => setPicked(event.target.value)}>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
      <p className="ms-note">Hermes keeps aliases per agent profile.</p>
      <AliasEditor key={agentId} agentId={agentId} />
    </div>
  )
}
