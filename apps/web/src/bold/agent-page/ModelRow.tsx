import type { ReactNode } from 'react'

/**
 * One row of the Model section (mock-up 26): a label, what it is now, and a button that opens that row's form in
 * place. On a phone the label sits over the value and the button keeps a 44px target.
 */
export function ModelRow({
  id,
  label,
  summary,
  action,
  actionLabel,
  open,
  onToggle,
  children,
}: {
  id: string
  label: string
  summary: ReactNode
  /** The button's visible words while the form is closed: Change, Edit, Add fallback. */
  action: string
  /** Its accessible name, so every button on the page says which row it belongs to. */
  actionLabel: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="bold-model-row" data-open={open || undefined}>
      <span className="bold-model-label" id={`${id}-label`}>
        {label}
      </span>
      <span className="bold-model-value">{summary}</span>
      <button
        type="button"
        className="btn sm bold-model-btn"
        aria-expanded={open}
        aria-controls={`${id}-form`}
        aria-label={open ? `Close ${label.toLowerCase()}` : actionLabel}
        onClick={onToggle}
      >
        {open ? 'Close' : action}
      </button>
      {open && (
        <div className="bold-model-form" id={`${id}-form`}>
          {children}
        </div>
      )}
    </div>
  )
}
