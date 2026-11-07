import type { WorkflowDefinition } from '@score/contract'
import { ownText } from './workflow-model.ts'

export function StartWorkflowInputs({
  inputs,
  values,
  onChange,
}: {
  inputs: WorkflowDefinition['inputs']
  values: Record<string, string>
  onChange: (name: string, value: string) => void
}) {
  return (
    <fieldset className="orch-field wf-fieldset">
      <legend>Inputs</legend>
      {inputs.map((input) => (
        <label key={input.name} className="orch-field">
          <span>
            {input.label}
            {input.required ? '' : ' (optional)'}
          </span>
          <textarea
            rows={input.maxChars > 200 ? 3 : 1}
            value={ownText(values, input.name)}
            maxLength={input.maxChars}
            required={input.required}
            onChange={(event) => onChange(input.name, event.target.value)}
          />
          <small className="orch-muted">
            {ownText(values, input.name).length} of {input.maxChars} characters
          </small>
        </label>
      ))}
    </fieldset>
  )
}
