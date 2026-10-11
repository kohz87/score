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

const OPEN_KEY = 'score.settings.advancedOpen'
function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}
function saveOpen(open: boolean) {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? '1' : '0')
  } catch {
    // Storage blocked: the list still opens, it just isn't remembered.
  }
}

export function AdvancedSection() {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(readOpen)
  const [q, setQ] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250)
    return () => clearTimeout(timer)
  }, [text])
  const search = useConfigSearch(q)
  const searching = text.trim() !== ''
  const expanded = open || searching
  // While a new search is on its way the previous answer is all there is: narrow it to what was typed, so the list
  // never shows settings that don't match (the server's answer replaces it when it arrives).
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean)
  const items = (search.data ?? []).filter(
    (item) =>
      !(search.isPlaceholderData || q !== text.trim()) ||
      terms.every(
        (term) =>
          item.key.toLowerCase().includes(term) ||
          (item.description ?? '').toLowerCase().includes(term),
      ),
  )
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
            ? 'One of these settings can’t be changed here.'
            : 'Couldn’t preview the changes. Try again.',
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
            setMessage(
              'The settings changed since the preview. Preview again to see the new changes.',
            )
          } else if (error instanceof ApiError && error.code === 'not_paired')
            setMessage('Pair this browser using the link in the server terminal to apply changes.')
          else setMessage('Couldn’t apply the changes. Try again.')
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
            Every Hermes setting, searchable, with the file it lives in. You see the changes before
            they’re saved.
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
        Keys, passwords and other credentials are never shown or changed here. Approval rules live
        in Rules and approvals.
      </p>
      {search.status === 'error' && <p role="alert">Couldn’t search settings.</p>}
      {/* A search with text opens the list on its own; the disclosure matters when the box is empty. */}
      {!searching && search.data && (
        <button
          type="button"
          className="settings-link advanced-disclosure"
          aria-expanded={open}
          aria-controls="advanced-results"
          onClick={() => {
            setOpen(!open)
            saveOpen(!open)
          }}
        >
          {open ? 'Hide settings' : `Show all ${search.data.length} settings`}
        </button>
      )}
      {expanded && search.data && (
        <ul
          id="advanced-results"
          className="advanced-results"
          aria-label="Settings"
          aria-busy={search.isFetching}
        >
          {items.length === 0 && (
            <li className="settings-muted">
              {search.isFetching ? 'Searching…' : 'No settings match.'}
            </li>
          )}
          {items.map((item) => {
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
                      Add change
                    </button>
                    <button
                      type="button"
                      className="settings-link"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                    {invalid && <span role="alert">That isn’t a valid value.</span>}
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
            <pre className="advanced-diff" aria-label="Changes preview">
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
