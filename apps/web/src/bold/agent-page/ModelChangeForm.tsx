import { useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { AgentDetail } from '@score/contract'
import { ModelPicker, type ModelChoice } from '../../components/ModelPicker.tsx'
import { agentDisplayName } from '../bold-agents.ts'
import { ApiError } from '../../data/api.ts'
import { pinRoutines } from '../models/model-queries.ts'
import { RoutinesModelWarning } from '../models/RoutinesModelWarning.tsx'
import { routinesKey, useRoutines } from '../../routes/team/routine-queries.ts'
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
  // Repeating jobs follow the agent's model (decision 182): in the bold shell a change asks first when any of them would move.
  const queryClient = useQueryClient()
  const routines = useRoutines(agent.id).data ?? []
  const [warn, setWarn] = useState<{ next: ModelChoice; busy: boolean; failed: boolean } | null>(
    null,
  )
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
          void queryClient.invalidateQueries({ queryKey: routinesKey(agent.id) })
        },
      },
    )
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    const differs = choice.model.trim() !== current.model
    if (inBold && differs && routines.some((job) => !job.model))
      setWarn({ next: choice, busy: false, failed: false })
    else save(choice)
  }
  function keepThenChange(next: ModelChoice) {
    setWarn({ next, busy: true, failed: false })
    pinRoutines(agent.id)
      .then(() => {
        setWarn(null)
        save(next)
      })
      .catch(() => {
        // Some jobs may have been pinned before it stopped: the list shows what Hermes holds now.
        void queryClient.invalidateQueries({ queryKey: routinesKey(agent.id) })
        setWarn({ next, busy: false, failed: true })
      })
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
        {warn && (
          <RoutinesModelWarning
            agentName={agentDisplayName(agent)}
            current={current.model}
            next={warn.next.model.trim()}
            jobs={routines}
            busy={warn.busy}
            failed={warn.failed}
            onKeep={() => keepThenChange(warn.next)}
            onChange={() => {
              setWarn(null)
              save(warn.next)
            }}
            onCancel={() => setWarn(null)}
          />
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
