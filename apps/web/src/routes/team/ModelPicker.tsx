import {
  CodingModelsResponseSchema,
  type CodingModelOption,
  type CodingRuntime,
} from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '../../data/api.ts'

const OTHER = '__other__'
// What the server accepts for a model name (CodingAgentCreateSchema).
export const MODEL_PATTERN = '[A-Za-z0-9][A-Za-z0-9._:\\/@+\\-]*'

export interface ModelChoices {
  /** Models that share a family ("Gemini 4 Argon (Low)", "… (High)") sit together under that family's name. */
  groups: { family: string; models: CodingModelOption[] }[]
  single: CodingModelOption[]
}

/** Antigravity names carry the effort in brackets: group by what comes before it, when at least two share it. */
export function modelChoices(models: CodingModelOption[]): ModelChoices {
  const familyOf = (name: string) => /^(.+?) \([^()]+\)$/.exec(name)?.[1] ?? null
  const counts = new Map<string, number>()
  for (const model of models) {
    const family = familyOf(model.name)
    if (family) counts.set(family, (counts.get(family) ?? 0) + 1)
  }
  const groups = new Map<string, CodingModelOption[]>()
  const single: CodingModelOption[] = []
  for (const model of models) {
    const family = familyOf(model.name)
    if (family && (counts.get(family) ?? 0) > 1) {
      groups.set(family, [...(groups.get(family) ?? []), model])
    } else single.push(model)
  }
  return { groups: [...groups].map(([family, list]) => ({ family, models: list })), single }
}

export function useCodingModels(runtime: CodingRuntime) {
  return useQuery({
    queryKey: ['coding', 'models', runtime],
    // The server keeps a list for 5 minutes; opening the form asks it to look again.
    queryFn: async ({ signal }) =>
      CodingModelsResponseSchema.parse(
        await apiFetch(`coding-agents/runtimes/${runtime}/models?fresh=1`, { signal }),
      ),
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
  })
}

/**
 * The model of a coding agent: "CLI default", the CLI's own models, then "Other…" for a name typed by hand. When the
 * list can't be read, a plain text field, as before. `value` is '' for the CLI's default.
 */
export function ModelPicker({
  runtime,
  value,
  onChange,
  label = 'Model',
}: {
  runtime: CodingRuntime
  value: string
  onChange: (value: string) => void
  label?: string
}) {
  const models = useCodingModels(runtime)
  const [pickedOther, setPickedOther] = useState(false)
  const list = models.data?.models ?? []
  const textField = (text: string) => (
    <label>
      {text}
      <input
        value={value}
        maxLength={200}
        pattern={MODEL_PATTERN}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )

  if (models.isPending)
    return (
      <label>
        {label}
        <select disabled value="">
          <option value="">Loading models…</option>
        </select>
      </label>
    )
  if (models.error || list.length === 0)
    return textField(`${label} (optional, the CLI’s default otherwise)`)

  const choices = modelChoices(list)
  const selected = list.find((model) => model.id === value)
  const other = pickedOther || (value !== '' && !selected)
  const option = (model: CodingModelOption) => (
    <option key={model.id} value={model.id}>
      {model.name}
    </option>
  )
  return (
    <>
      <label>
        {label}
        <select
          value={other ? OTHER : value}
          onChange={(event) => {
            const next = event.target.value
            setPickedOther(next === OTHER)
            onChange(next === OTHER ? '' : next)
          }}
        >
          <option value="">CLI default</option>
          {choices.groups.map((group) => (
            <optgroup key={group.family} label={group.family}>
              {group.models.map(option)}
            </optgroup>
          ))}
          {choices.single.map(option)}
          <option value={OTHER}>Other…</option>
        </select>
      </label>
      {other && textField('Model name')}
      {!other && selected && (selected.description || selected.efforts) && (
        <p className="team-muted">
          {[
            selected.description,
            selected.efforts ? `Reasoning levels: ${selected.efforts.join(', ')}.` : null,
          ]
            .filter(Boolean)
            .join(' ')}
        </p>
      )}
      {!other && value === '' && <p className="team-muted">The CLI picks its own model.</p>}
    </>
  )
}
