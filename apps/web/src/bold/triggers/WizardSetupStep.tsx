import { useId } from 'react'
import type { TeamChoice } from '../room/team-choice.tsx'
import type { Wizard } from './wizard-model.ts'

export function WizardSetupStep({
  wizard,
  appSuggestions,
  teams,
  onChange,
  onClose,
  onCreate,
}: {
  wizard: Wizard
  appSuggestions: string[]
  teams: TeamChoice
  onChange: (change: Partial<Wizard>) => void
  onClose: () => void
  onCreate: () => void
}) {
  const appListId = useId()

  return (
    <div className="bold-trigger-form">
      <label>
        <span>Name</span>
        <input
          className="field"
          required
          maxLength={100}
          placeholder="e.g. New support ticket"
          value={wizard.name}
          onChange={(event) => onChange({ name: event.target.value, problem: '' })}
        />
      </label>
      <label>
        <span>App it comes from</span>
        <input
          className="field"
          required
          maxLength={100}
          list={appListId}
          placeholder="e.g. Tickets app"
          value={wizard.app}
          onChange={(event) => onChange({ app: event.target.value, problem: '' })}
        />
        <datalist id={appListId}>
          {appSuggestions.map((app) => (
            <option key={app} value={app} />
          ))}
        </datalist>
      </label>
      {teams.several && (
        <label>
          <span>Starts jobs in</span>
          <select
            className="field"
            value={wizard.teamRoomId ?? teams.teams[0]!.id}
            onChange={(event) =>
              onChange({
                teamRoomId: event.target.value === teams.teams[0]!.id ? null : event.target.value,
                problem: '',
              })
            }
          >
            {teams.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <span className="small muted">
        {wizard.mode === 'create' && !wizard.triggerId
          ? 'Score makes the address and shows its secret once. The app sends one signed test call before you map fields.'
          : 'The address and secret stay the same. Change the name or app, then check the mapping.'}
      </span>
      <div className="row wrap bold-trigger-actions">
        <button type="button" className="link" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary bold-trigger-push"
          disabled={wizard.busy || !wizard.name.trim() || !wizard.app.trim()}
          onClick={() => {
            if (wizard.mode === 'create' && !wizard.triggerId) onCreate()
            else onChange({ step: 2, problem: '' })
          }}
        >
          {wizard.busy
            ? 'Working…'
            : wizard.mode === 'create' && !wizard.triggerId
              ? 'Create the address'
              : 'Next'}
        </button>
      </div>
    </div>
  )
}
