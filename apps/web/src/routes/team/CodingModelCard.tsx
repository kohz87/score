import { CODING_EFFORTS, advisorChoicesFor, type CodingAgent } from '@score/contract'
import { useId, useState } from 'react'
import { runtimeLabel } from '../../components/runtime-label.ts'
import { EffortSelect } from '../../components/model-settings/EffortSelect.tsx'
import { ModelPicker, useCodingModels } from './ModelPicker.tsx'
import { useCodingPatch } from './coding-agent-queries.ts'

/** The model, large like a Hermes agent's Model card; "Change model" opens the picker right here. */
export function CodingModelCard({
  coding,
  onChanged,
}: {
  coding: CodingAgent
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  return (
    <section className="team-card" aria-labelledby="coding-model" data-protected="block">
      <h2 id="coding-model">Model</h2>
      {editing ? (
        // The drafts live in the editor, so Cancel and a saved change unmount them: nothing stale is kept.
        <ModelEditor coding={coding} onChanged={onChanged} onClose={() => setEditing(false)} />
      ) : (
        <>
          <p className="team-model-name">{coding.model ?? 'CLI default'}</p>
          <p className="team-muted-strong">
            {coding.model
              ? `Set for this agent. ${runtimeLabel(coding.runtime) ?? coding.runtime} uses it for every turn.`
              : 'The CLI picks its own model.'}
          </p>
          {CODING_EFFORTS[coding.runtime] && (
            <p className="team-muted-strong">Effort: {coding.effort ?? 'Default'}</p>
          )}
          {coding.runtime === 'claude-code' && (
            <p className="team-muted-strong">
              Advisor:{' '}
              {coding.advisorModel
                ? `${advisorNames[coding.advisorModel]}. It asks when stuck and before it reports work done.`
                : 'Off'}
            </p>
          )}
          <button type="button" className="team-text-action" onClick={() => setEditing(true)}>
            Change model
          </button>
        </>
      )}
    </section>
  )
}

function ModelEditor({
  coding,
  onChanged,
  onClose,
}: {
  coding: CodingAgent
  onChanged: () => void
  onClose: () => void
}) {
  const [model, setModel] = useState(coding.model ?? '')
  const [effort, setEffort] = useState(coding.effort ?? '')
  const [advisor, setAdvisor] = useState<string>(coding.advisorModel ?? '')
  const [advisorDropped, setAdvisorDropped] = useState(false)
  const save = useCodingPatch(coding, onChanged, onClose)
  const models = useCodingModels(coding.runtime)
  const runtimeLevels = CODING_EFFORTS[coding.runtime]
  // Codex lists the levels per model; when the chosen model lists some, offer those the server accepts.
  const levelsFor = (modelId: string) => {
    const own = models.data?.models.find((item) => item.id === modelId.trim())?.efforts
    return coding.runtime === 'codex' && own?.length
      ? (runtimeLevels ?? []).filter((level) => own.includes(level))
      : (runtimeLevels ?? [])
  }
  const levels = levelsFor(model)
  // A model that doesn't list the current level puts the choice back on Default: that level is never sent for it.
  const pickModel = (next: string) => {
    setModel(next)
    if (effort !== '' && !levelsFor(next).includes(effort)) setEffort('')
    // The advisor must stay stronger than the model: a model that catches up turns it off.
    // Only the change that drops it says so; any later model change clears the notice (review).
    const drops =
      advisor !== '' && !advisorChoicesFor(next.trim() || null).includes(advisor as never)
    setAdvisorDropped(drops)
    if (drops) setAdvisor('')
  }
  const advisorChoices = advisorChoicesFor(model.trim() || null)
  return (
    <form
      className="team-routine-form"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate({
          model: model.trim() || null,
          ...(runtimeLevels && effort !== (coding.effort ?? '') ? { effort: effort || null } : {}),
          ...(coding.runtime === 'claude-code' && advisor !== (coding.advisorModel ?? '')
            ? { advisorModel: (advisor || null) as CodingAgent['advisorModel'] }
            : {}),
        })
      }}
    >
      <ModelPicker runtime={coding.runtime} value={model} onChange={pickModel} />
      {runtimeLevels && <EffortSelect value={effort} levels={levels} onChange={setEffort} />}
      {coding.runtime === 'claude-code' && (
        <AdvisorSelect
          value={advisor}
          choices={advisorChoices}
          dropped={advisorDropped && advisor === ''}
          onChange={(next) => {
            setAdvisor(next)
            setAdvisorDropped(false)
          }}
        />
      )}
      {save.error && <p role="alert">{save.error.message}</p>}
      <div className="team-file-actions">
        <button className="team-primary" disabled={save.isPending}>
          Save
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  )
}

const advisorNames: Record<NonNullable<CodingAgent['advisorModel']>, string> = {
  sonnet: 'Sonnet',
  opus: 'Opus',
  fable: 'Fable',
}

/**
 * 3.14.1: Claude Code's own advisor (`--advisor`): a stronger model the agent consults when it decides to. Only models
 * above the agent's own are offered; the advice stays inside Claude Code (Score sees that it asked, not what was said).
 */
function AdvisorSelect({
  value,
  choices,
  dropped,
  onChange,
}: {
  value: string
  choices: readonly string[]
  /** A model change caught up with the advisor and turned it off (review: say so). */
  dropped: boolean
  onChange: (value: string) => void
}) {
  const id = useId()
  const hint = useId()
  // The hint sits outside the label so the select's name stays "Advisor".
  return (
    <>
      <label className="ms-field" htmlFor={id}>
        Advisor
        <select
          id={id}
          value={value}
          aria-describedby={hint}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Off</option>
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {advisorNames[choice as keyof typeof advisorNames]}
            </option>
          ))}
        </select>
      </label>
      <p id={hint} className="team-muted">
        {choices.length === 0
          ? 'No stronger model to advise this one.'
          : 'A stronger model it consults when stuck and before it reports work done. Uses your Claude plan.'}{' '}
        {/* Announced as it happens, for someone still typing in the model field; empty takes no room (review). */}
        <span role="status">
          {dropped
            ? 'Advisor turned off: the model is now as strong as it. Pick a stronger one or leave it off.'
            : ''}
        </span>
      </p>
    </>
  )
}
