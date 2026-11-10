import type { AgentSummary, PinnedModel } from '@score/contract'
import { useState } from 'react'
import { useModelChoices } from '../models/use-model-choices.ts'
import { ownModelText } from '../models/model-menu.ts'
import { Choices, Field } from './RepeatingFields.tsx'

// Tasks › Repeating (TR.2): Model. "Its own" follows the agent when the job runs; Pinned keeps one model, picked from
// the same list as /model (aliases, then the models the agent's provider lists).

const SHOWN = 8

export function ModelField({
  agent,
  mode,
  pinned,
  onMode,
  onPin,
}: {
  agent: AgentSummary | undefined
  mode: 'own' | 'pinned'
  pinned: PinnedModel | null
  onMode: (mode: 'own' | 'pinned') => void
  onPin: (pin: PinnedModel) => void
}) {
  const [search, setSearch] = useState('')
  const choices = useModelChoices(agent, mode === 'pinned' ? search : null)
  const rows = [...choices.aliases, ...choices.models]
  const shown = rows.slice(0, SHOWN)
  return (
    <Field
      label="Model"
      note="Its own follows the agent’s model when it runs. Pinned keeps one model, whatever the agent uses."
    >
      <Choices
        label="Model"
        value={mode}
        options={[
          { id: 'own', label: `Its own (${ownModelText(choices) || 'the agent’s model'})` },
          { id: 'pinned', label: 'Pinned' },
        ]}
        onPick={onMode}
      />
      {mode === 'pinned' && (
        <span className="bold-rj-pick">
          {pinned && (
            <span className="bold-rj-hint">
              Pinned to <b>{pinned.model}</b>
            </span>
          )}
          <input
            aria-label="Search models"
            placeholder="Search models"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <span className="bold-rj-models" role="radiogroup" aria-label="Pinned model">
            {shown.map((row) => (
              <button
                key={`${row.value}:${row.detail}`}
                type="button"
                role="radio"
                aria-checked={pinned?.model === row.value}
                onClick={() => onPin({ model: row.value, provider: row.provider ?? null })}
              >
                <code>{row.value}</code>
                <small>{row.detail}</small>
              </button>
            ))}
          </span>
          {rows.length > shown.length && (
            <span className="bold-rj-hint">
              + {rows.length - shown.length} more: type to narrow
            </span>
          )}
          {choices.ready && rows.length === 0 && (
            <span className="bold-rj-hint">No model matches.</span>
          )}
        </span>
      )}
    </Field>
  )
}
