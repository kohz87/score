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
  local = false,
}: {
  providerId: string
  label: string
  onSaved: () => void
  onClose: () => void
  onTerminal?: () => void
  /** A local model's key: any printable key from 1 character, no label, no terminal route. */
  local?: boolean
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
        ...(!local && keyLabel.trim() ? { label: keyLabel.trim() } : {}),
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
          minLength={local ? 1 : 8}
          maxLength={512}
          pattern={local ? '[\\x21-\\x7e]{1,512}' : '[\\x21-\\x7e]{8,512}'}
          title={local ? 'Up to 512 characters, no spaces' : '8–512 characters, no spaces'}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>
      {!local && (
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
      )}
      {error && <p role="alert">{error}</p>}
      <div className="settings-command-actions">
        <button type="submit" className="settings-primary" disabled={busy || apiKey.length === 0}>
          {busy ? 'Saving…' : 'Save key'}
        </button>
        <button type="button" className="settings-link" onClick={onClose}>
          Cancel
        </button>
        {onTerminal && !local && (
          <button type="button" className="settings-link" onClick={onTerminal}>
            Use a terminal instead
          </button>
        )}
      </div>
    </form>
  )
}
