import { useEffect, useState, type FormEvent } from 'react'
import { sendProviderKey } from './settings-queries.ts'

// A key travels from this field to the server and on to `hermes auth add` on stdin (ARCHITECTURE D2.7). It is held only
// in this component's state, cleared on success, failure and unmount, and never put in a query cache.
function message(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
  if (code === 'not_paired')
    return 'Pair this browser using the link in the server terminal to save a key.'
  if (code === 'not_verified') return 'Hermes did not accept that key. Check it and try again.'
  if (code === 'bad_request')
    return 'That does not look like an API key (8–512 characters, no spaces).'
  return 'Couldn’t save the key. Try again.'
}

export function ApiKeyPanel({
  providerId,
  label,
  onSaved,
  onClose,
  onTerminal,
}: {
  providerId: string
  label: string
  onSaved: () => void
  onClose: () => void
  onTerminal: () => void
}) {
  const [apiKey, setApiKey] = useState('')
  const [keyLabel, setKeyLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Leaving the page drops the key from state.
  useEffect(() => () => setApiKey(''), [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await sendProviderKey(providerId, {
        apiKey,
        ...(keyLabel.trim() ? { label: keyLabel.trim() } : {}),
      })
      setApiKey('')
      setBusy(false)
      onSaved()
    } catch (failure) {
      setApiKey('')
      setBusy(false)
      setError(message(failure))
    }
  }

  return (
    <form
      className="settings-form settings-key"
      aria-label={`Add a key for ${label}`}
      onSubmit={(event) => void submit(event)}
    >
      <label>
        API key
        <input
          type="password"
          required
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          minLength={8}
          maxLength={512}
          pattern="[\x21-\x7e]{8,512}"
          title="8–512 characters, no spaces"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>
      <label>
        Label (optional)
        <input
          maxLength={64}
          autoComplete="off"
          pattern="[A-Za-z0-9][A-Za-z0-9 ._\-]{0,63}"
          title="Letters, numbers, spaces, dots, dashes"
          value={keyLabel}
          onChange={(event) => setKeyLabel(event.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="settings-command-actions">
        <button type="submit" className="settings-primary" disabled={busy || apiKey.length === 0}>
          {busy ? 'Saving…' : 'Save key'}
        </button>
        <button type="button" className="settings-link" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="settings-link" onClick={onTerminal}>
          Use a terminal instead
        </button>
      </div>
    </form>
  )
}
