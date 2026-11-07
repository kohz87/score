import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

/** The decision to delete a recipe together with its runs: the person types the recipe's name (3.8.0). */
export function DeleteWithRunsDialog({
  name,
  runs,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  name: string
  runs: number
  pending: boolean
  error: string
  onCancel: () => void
  onConfirm: (confirm: string) => void
}) {
  const [typed, setTyped] = useState('')
  const inputId = useId()
  const input = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => input.current?.focus(), [])
  // Escape cancels and Tab stays inside, as in the other confirmations.
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      if (!pending) onCancel()
      return
    }
    if (event.key !== 'Tab' || !dialog.current) return
    const items = [
      ...dialog.current.querySelectorAll<HTMLElement>('input, button:not(:disabled)'),
    ].filter((item) => !item.hasAttribute('disabled'))
    const first = items[0]
    const last = items.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  return (
    <div className="bold-rp-scrim">
      <section
        ref={dialog}
        onKeyDown={onKeyDown}
        className="card bold-rp-confirm"
        data-protected="flex"
        role="alertdialog"
        aria-modal="true"
        aria-label="Delete recipe with its runs"
      >
        <h3>Delete {name} with its runs?</h3>
        <p>
          {runs > 0
            ? `This deletes ${runs} ${runs === 1 ? 'run' : 'runs'} of this recipe, with their rooms, and the recipe itself.`
            : 'This deletes every run of this recipe, with their rooms, and the recipe itself.'}{' '}
          It can’t be undone. Archive keeps the runs.
        </p>
        <label className="bold-lab" htmlFor={inputId}>
          Type the recipe’s name to confirm
          <input
            ref={input}
            id={inputId}
            className="bold-field"
            value={typed}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="bold-error">
            {error}
          </p>
        )}
        <div className="row wrap">
          <button type="button" className="link" disabled={pending} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary bold-danger"
            disabled={pending || typed.trim() !== name.trim()}
            onClick={() => onConfirm(typed.trim())}
          >
            {pending ? 'Deleting…' : 'Delete recipe and runs'}
          </button>
        </div>
      </section>
    </div>
  )
}
