import { useEffect, useState, type FormEvent } from 'react'
import type { MessagingField } from '@score/contract'
import { TerminalCommand } from './TerminalCommand.tsx'
import { sendMessagingValues, useMessagingFields } from './settings-queries.ts'

// Tokens travel from these inputs to the server and on to `hermes config set`. They live only in this component's
// state, are cleared on success, failure and unmount, and never enter a query cache.
function message(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
  if (code === 'not_paired')
    return 'Pair this browser using the link in the server terminal to save these.'
  if (code === 'bad_request')
    return 'Check the fields: a required one is empty or has an invalid value.'
  return 'Hermes did not accept these settings. Please try again.'
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: MessagingField
  value: string
  onChange: (value: string) => void
}) {
  const [shown, setShown] = useState(false)
  return (
    <div className="settings-field">
      <label>
        {field.label}
        {field.required ? '' : ' (optional)'}
        <input
          type={field.secret && !shown ? 'password' : 'text'}
          required={field.required}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          maxLength={2000}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {field.secret && (
        <button
          type="button"
          className="settings-link"
          aria-pressed={shown}
          aria-label={`${shown ? 'Hide' : 'Show'} ${field.label}`}
          onClick={() => setShown((current) => !current)}
        >
          {shown ? 'Hide' : 'Show'}
        </button>
      )}
      {field.help && <p className="settings-muted">{field.help}</p>}
      {field.url && (
        <p>
          <a href={field.url} target="_blank" rel="noreferrer noopener">
            Where to get it
          </a>
        </p>
      )}
    </div>
  )
}

export function MessagingSetup({
  platform,
  label,
  agentId,
  terminalCommand,
  onSaved,
  onClose,
}: {
  platform: string
  label: string
  agentId?: string
  terminalCommand: string
  onSaved: () => void
  onClose: () => void
}) {
  const fields = useMessagingFields(platform)
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => () => setValues({}), [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await sendMessagingValues(platform, {
        values: Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim())),
        ...(agentId ? { agentId } : {}),
      })
      setValues({})
      setBusy(false)
      setSaved(true)
      onSaved()
    } catch (failure) {
      setValues({})
      setBusy(false)
      setError(message(failure))
    }
  }

  if (fields.isPending) return <p role="status">Loading the {label} setup…</p>
  if (fields.isError)
    return <p role="alert">Could not load the {label} setup. Please try again later.</p>
  if (!fields.data.browserSetup)
    return (
      <div>
        <p>This one needs the terminal: {label} has to be paired interactively.</p>
        <TerminalCommand command={terminalCommand} onClose={onClose} />
      </div>
    )
  if (saved)
    return (
      <div className="settings-command" role="status">
        <p>
          Saved. The gateway picks up the new {label} settings the next time it starts, so restart
          it (<code>hermes gateway restart</code>) for the status to change.
        </p>
        <button type="button" className="settings-link" onClick={onClose}>
          Done
        </button>
      </div>
    )
  return (
    <form
      className="settings-form settings-key"
      aria-label={`Connect ${label}`}
      onSubmit={(event) => void submit(event)}
    >
      {fields.data.fields.map((field) => (
        <FieldInput
          key={field.key}
          field={field}
          value={values[field.key] ?? ''}
          onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
        />
      ))}
      {error && <p role="alert">{error}</p>}
      <div className="settings-command-actions">
        <button type="submit" className="settings-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="settings-link" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  )
}
