import { useState } from 'react'
import { EFFORT_LEVELS, EffortLevelSchema, type ModelSettings } from '@score/contract'
import { tabFailure } from '../../routes/team/tab-errors.ts'
import { useUpdateModelSettings } from '../../routes/team/model-settings-queries.ts'
import { EffortSelect } from './EffortSelect.tsx'
import './model-settings.css'

/** Team › agent › Model: Hermes's `agent.reasoning_effort` (Default = the model's own). */
export function EffortSetting({ agentId, settings }: { agentId: string; settings: ModelSettings }) {
  const update = useUpdateModelSettings(agentId)
  const before = settings.effort ?? ''
  const [draft, setDraft] = useState(before)
  const parsed = EffortLevelSchema.safeParse(draft)
  const changed = draft !== before && (draft === '' || parsed.success)
  return (
    <form
      className="ms-block"
      aria-labelledby="ms-effort-heading"
      onSubmit={(event) => {
        event.preventDefault()
        if (changed) update.mutate({ effort: parsed.success ? parsed.data : null })
      }}
    >
      <h3 id="ms-effort-heading">Effort</h3>
      <p className="ms-note">
        How much the model thinks before it answers. Default leaves it to the model.
      </p>
      <div className="ms-grid">
        <EffortSelect value={draft} levels={EFFORT_LEVELS} onChange={setDraft} />
      </div>
      <div className="ms-actions">
        <button
          type="submit"
          className="ms-button"
          data-primary=""
          disabled={!changed || update.isPending}
        >
          {update.isPending ? 'Saving…' : 'Save effort'}
        </button>
      </div>
      {update.isError && <p role="alert">{tabFailure(update.error, 'save the effort')}</p>}
    </form>
  )
}
