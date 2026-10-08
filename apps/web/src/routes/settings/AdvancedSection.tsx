import { useEffect, useState, type FormEvent } from 'react'
import type { ConfigChange, ConfigItem } from '@score/contract'
import { ApiError } from '../../data/api.ts'
import { useConfigActions, useConfigSearch } from './settings-queries.ts'

function show(value: unknown): string {
  if (typeof value === 'string') return value === '' ? '""' : value
  return JSON.stringify(value) ?? 'null'
}
// A text box edits every type: strings stay as typed, anything else is read as JSON (true, 30, [..]).
function parse(text: string, current: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof current === 'string') return { ok: true, value: text }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return typeof current === 'undefined' || current === null
      ? { ok: true, value: text }
      : { ok: false }
  }
}

export function AdvancedSection() {
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250)
    return () => clearTimeout(timer)
  }, [text])
  const search = useConfigSearch(q)
  const { preview, apply } = useConfigActions()
  const [editing, setEditing] = useState<{ key: string; draft: string } | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [pending, setPending] = useState<Record<string, unknown>>({})
  const [previewed, setPreviewed] = useState<{ diff: string; hash: string } | null>(null)
  const [done, setDone] = useState<{ restart: boolean } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const changes: ConfigChange[] = Object.entries(pending).map(([key, value]) => ({
    key,
    value: value as ConfigChange['value'],
  }))

  function changed() {
    // Any edit invalidates the diff the person looked at.
    setPreviewed(null)
    setDone(null)
    setMessage(null)
  }
  function startEdit(item: ConfigItem) {
    const value = item.key in pending ? pending[item.key] : item.value
    setEditing({ key: item.key, draft: show(value) })
    setInvalid(false)
  }
  function stage(event: FormEvent, item: ConfigItem) {
    event.preventDefault()
    const result = parse(editing!.draft, item.value)
    if (!result.ok) return setInvalid(true)
    changed()
    setPending((all) => ({ ...all, [item.key]: result.value }))
    setEditing(null)
  }
  function drop(key: string) {
    changed()
    setPending((all) => Object.fromEntries(Object.entries(all).filter(([name]) => name !== key)))
  }
  function runPreview() {
    setMessage(null)
    preview.mutate(changes, {
      onSuccess: (result) => setPreviewed({ diff: result.diff, hash: result.hash }),
      onError: (error) =>
        setMessage(
          error instanceof ApiError && error.status === 400
            ? 'One of these settings cannot be changed here.'
            : 'Could not preview the changes. Please try again.',
        ),
    })
  }
  function runApply() {
    if (!previewed) return
    const submitted = pending
    apply.mutate(
      { changes, expectedDiffHash: previewed.hash },
      {
        onSuccess: (result) => {
          // Keep anything staged or re-staged while the request was in flight.
          setPending((all) =>
            Object.fromEntries(
              Object.entries(all).filter(
                ([key, value]) => !(key in submitted) || submitted[key] !== value,
              ),
            ),
          )
          setPreviewed(null)
          setDone({ restart: result.restartRequired })
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status === 409) {
            setPreviewed(null)
            setMessage('The settings changed since the preview. Preview again to see the new diff.')
          } else if (error instanceof ApiError && error.code === 'not_paired')
            setMessage('Pair this browser using the link in the server terminal to apply changes.')
          else setMessage('Could not apply the changes. Please try again.')
        },
      },
    )
  }

  return (
    <section id="advanced" className="settings-card" aria-labelledby="settings-advanced">
      <div className="advanced-head">
        <div className="advanced-intro">
          <h2 id="settings-advanced">Advanced</h2>
          <p className="settings-muted-strong">
            Every Hermes setting, searchable, with the file it lives in. Changes show as a diff
            before they&apos;re saved.
          </p>
        </div>
        <input
          type="search"
          className="advanced-search"
          aria-label="Search settings"
          placeholder="Search settings, like compression or timeout"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      <p className="settings-muted">
        Keys, tokens, passwords and other credentials are never shown or changed here. Approval
        rules live in Rules and approvals.
      </p>
      {search.status === 'error' && <p role="alert">Could not search settings.</p>}
      {search.data && (
        <ul className="advanced-results" aria-label="Settings" aria-busy={search.isFetching}>
          {search.data.length === 0 && <li className="settings-muted">No settings match.</li>}
          {search.data.map((item) => {
            const staged = item.key in pending
            return (
              <li key={item.key} className="advanced-item">
                <div className="advanced-line">
                  <code className="advanced-key">{item.key}</code>
                  <span className="settings-muted">{item.file}</span>
                </div>
                {item.description && <p className="settings-muted">{item.description}</p>}
                {editing?.key === item.key ? (
                  <form className="advanced-edit" onSubmit={(event) => stage(event, item)}>
                    <input
                      aria-label={`New value for ${item.key}`}
                      value={editing.draft}
                      onChange={(event) => setEditing({ ...editing, draft: event.target.value })}
                    />
                    <button type="submit" className="settings-pill">
                      Stage change
                    </button>
                    <button
                      type="button"
                      className="settings-link"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                    {invalid && <span role="alert">That is not a valid value.</span>}
                  </form>
                ) : (
                  <div className="advanced-line">
                    <code className="advanced-value" data-staged={staged}>
                      {show(staged ? pending[item.key] : item.value)}
                    </code>
                    {staged && <span className="settings-status">Pending</span>}
                    <button
                      type="button"
                      className="settings-link"
                      aria-label={`Edit ${item.key}`}
                      onClick={() => startEdit(item)}
                    >
                      Edit
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {changes.length > 0 && (
        <div className="advanced-tray" role="group" aria-label="Pending changes">
          <h3>Pending changes ({changes.length})</h3>
          <ul>
            {changes.map((change) => (
              <li key={change.key}>
                <code>
                  {change.key} = {show(change.value)}
                </code>
                <button
                  type="button"
                  className="settings-link"
                  aria-label={`Discard ${change.key}`}
                  onClick={() => drop(change.key)}
                >
                  Discard
                </button>
              </li>
            ))}
          </ul>
          {previewed && (
            <pre className="advanced-diff" aria-label="Diff">
              {previewed.diff === '' ? 'No difference from the current settings.' : previewed.diff}
            </pre>
          )}
          <div className="settings-command-actions">
            <button
              type="button"
              className="settings-pill"
              disabled={preview.isPending}
              onClick={runPreview}
            >
              Preview
            </button>
            <button
              type="button"
              className="settings-primary"
              disabled={!previewed || apply.isPending}
              onClick={runApply}
            >
              Apply
            </button>
          </div>
        </div>
      )}
      {message && <p role="alert">{message}</p>}
      {done && (
        <p role="status">
          Saved.{' '}
          {done.restart ? 'Restart the gateway for this to take effect.' : 'It applies right away.'}
        </p>
      )}
    </section>
  )
}
