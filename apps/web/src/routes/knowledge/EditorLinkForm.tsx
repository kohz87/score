import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { KnowledgeNoteSummary } from '@score/contract'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { insertLink, linkSelectionText } from './editor-commands.ts'
import { baseName, linkTargetFor } from './knowledge-paths.ts'

export function LinkForm({
  view,
  state,
  notes,
  onDone,
  onCancel,
}: {
  view: EditorView
  state: EditorState
  notes: KnowledgeNoteSummary[]
  onDone: () => void
  onCancel: () => void
}) {
  const [text, setText] = useState(() => linkSelectionText(state))
  const [kind, setKind] = useState<'web' | 'note'>('web')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])
  const options = useMemo(
    () => notes.slice(0, 200).map((note) => ({ target: linkTargetFor(note, notes), note })),
    [notes],
  )
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const entered = value.trim()
    if (kind === 'note') {
      const target = entered.replace(/^\[\[|\]\]$/g, '').trim()
      if (target === '') return setError('Choose or type the name of a note.')
      insertLink(view, text, { kind: 'note', target })
      return onDone()
    }
    const url = /^(https?:\/\/|mailto:)/i.test(entered)
      ? entered
      : /^[^\s/]+\.[^\s/]+/.test(entered)
        ? `https://${entered}`
        : ''
    if (url === '') return setError('Enter a web address such as https://example.com.')
    insertLink(view, text, { kind: 'web', url })
    onDone()
  }
  return (
    <form className="kn-tb-link" onSubmit={submit} aria-label="Insert link">
      <div role="radiogroup" aria-label="Link to" className="kn-tb-choices">
        {(['web', 'note'] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={kind === choice}
            onClick={() => {
              setKind(choice)
              setError(null)
            }}
          >
            {choice === 'web' ? 'Web address' : 'Another note'}
          </button>
        ))}
      </div>
      <label>
        Text
        <input value={text} maxLength={300} onChange={(event) => setText(event.target.value)} />
      </label>
      <label>
        {kind === 'web' ? 'Address' : 'Note'}
        <input
          ref={first}
          value={value}
          maxLength={1000}
          list={kind === 'note' ? 'kn-tb-notes' : undefined}
          placeholder={kind === 'web' ? 'https://' : 'Start typing a note name'}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'kn-tb-link-error' : undefined}
          onChange={(event) => {
            setValue(event.target.value)
            setError(null)
          }}
        />
      </label>
      {kind === 'note' && (
        <datalist id="kn-tb-notes">
          {options.map(({ target, note }) => (
            <option key={note.path} value={target} label={note.title || baseName(note.path)} />
          ))}
        </datalist>
      )}
      <button type="submit" className="kn-primary">
        Insert link
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      {error && (
        <p id="kn-tb-link-error" role="alert" className="kn-tb-error">
          {error}
        </p>
      )}
    </form>
  )
}
