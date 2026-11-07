import type { TeamChoice } from '../room/team-choice.tsx'
import { STEPS, type Secret, type Wizard } from './wizard-model.ts'
import { WizardMapStep } from './WizardMapStep.tsx'
import { WizardReportStep } from './WizardReportStep.tsx'
import { WizardSetupStep } from './WizardSetupStep.tsx'
import { WizardTestStep } from './WizardTestStep.tsx'

export function WizardBody({
  wizard,
  sample,
  url,
  secret,
  appSuggestions,
  teams,
  onChange,
  onClose,
  onCreate,
  onShowSecret,
  onSecretClose,
  onSave,
  onRefresh,
}: {
  wizard: Wizard
  sample: unknown | null
  url: string | null
  secret: Secret | null
  appSuggestions: string[]
  teams: TeamChoice
  onChange: (change: Partial<Wizard>) => void
  onClose: () => void
  onCreate: () => void
  onShowSecret: () => void
  onSecretClose: () => void
  onSave: () => void
  onRefresh: () => void
}) {
  return (
    <>
      <div className="row wrap bold-trigger-wizard-head">
        <h3>{wizard.mode === 'edit' ? 'Edit trigger' : 'New trigger'}</h3>
        <button type="button" className="link bold-trigger-push" onClick={onClose}>
          Close
        </button>
      </div>
      <ol className="bold-trigger-steps" aria-label="Trigger setup steps">
        {STEPS.map((label, index) => {
          const number = (index + 1) as 1 | 2 | 3 | 4
          return (
            <li
              key={label}
              className={wizard.step === number ? 'on' : wizard.step > number ? 'done' : undefined}
              aria-current={wizard.step === number ? 'step' : undefined}
            >
              <span>{number}</span>
              {label}
            </li>
          )
        })}
      </ol>

      {wizard.step === 1 && (
        <WizardSetupStep
          wizard={wizard}
          appSuggestions={appSuggestions}
          teams={teams}
          onChange={onChange}
          onClose={onClose}
          onCreate={onCreate}
        />
      )}

      {wizard.step === 2 && (
        <WizardTestStep
          wizard={wizard}
          sample={sample}
          url={url}
          secret={secret}
          onChange={onChange}
          onClose={onClose}
          onShowSecret={onShowSecret}
          onSecretClose={onSecretClose}
          onRefresh={onRefresh}
        />
      )}

      {wizard.step === 3 && <WizardMapStep wizard={wizard} sample={sample} onChange={onChange} />}

      {wizard.step === 4 && (
        <WizardReportStep wizard={wizard} onChange={onChange} onSave={onSave} />
      )}

      {wizard.problem && wizard.step !== 3 && wizard.step !== 4 && (
        <p role="alert">{wizard.problem}</p>
      )}
    </>
  )
}
