import type { Wizard } from './wizard-model.ts'

export function WizardReportStep({
  wizard,
  onChange,
  onSave,
}: {
  wizard: Wizard
  onChange: (change: Partial<Wizard>) => void
  onSave: () => void
}) {
  return (
    <div className="bold-trigger-report">
      <span className="small muted">
        At the end, Score can ask the lead to call a tool of its Hermes profile with a fixed
        argument template. The app’s token stays in Hermes.
      </span>
      <fieldset className="bold-trigger-modes">
        <legend>Report back</legend>
        {(
          [
            ['off', 'Don’t report back', 'Results stay in Score; the job still links to the item.'],
            [
              'fixed',
              'Post with a tool every time',
              'The lead calls this tool when the job is done.',
            ],
            [
              'lead_decides',
              'Let lead decide',
              'Lead picks the tool; you confirm the first report-back.',
            ],
          ] as const
        ).map(([mode, label, hint]) => (
          <label key={mode} className="bold-trigger-mode">
            <input
              type="radio"
              name="trigger-report-mode"
              value={mode}
              checked={wizard.reportMode === mode}
              onChange={() => onChange({ reportMode: mode, problem: '' })}
            />
            <span>
              <b>{label}</b>
              <span className="small muted">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {wizard.reportMode !== 'off' && (
        <div className="bold-trigger-form">
          <label>
            <span>Tool name</span>
            <input
              className="field"
              required
              maxLength={200}
              placeholder="e.g. add_comment"
              value={wizard.tool}
              onChange={(event) => onChange({ tool: event.target.value, problem: '' })}
            />
          </label>
          <label>
            <span>Arguments template (JSON)</span>
            <textarea
              className="field mono"
              required
              rows={5}
              value={wizard.args}
              onChange={(event) => onChange({ args: event.target.value, problem: '' })}
            />
          </label>
          <span className="small muted">
            Use JSON paths as holes, e.g. <code>{'{"id": "{{source.ref}}"}'}</code>. Every hole must
            sit inside a quoted string.
          </span>
        </div>
      )}
      {wizard.problem && <p role="alert">{wizard.problem}</p>}
      <div className="row wrap bold-trigger-actions">
        <button
          type="button"
          className="btn ghost"
          onClick={() => onChange({ step: 3, problem: '' })}
        >
          Back
        </button>
        <button
          type="button"
          className="btn primary bold-trigger-push"
          disabled={
            wizard.busy ||
            !wizard.mapping.ref ||
            !wizard.template.trim() ||
            (wizard.reportMode !== 'off' && (!wizard.tool.trim() || !wizard.args.trim()))
          }
          onClick={onSave}
        >
          {wizard.busy ? 'Saving…' : wizard.mode === 'edit' ? 'Save changes' : 'Save trigger'}
        </button>
      </div>
    </div>
  )
}
