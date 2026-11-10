import type { ReactNode } from 'react'

// Tasks › Repeating (TR.2): the panel's small building blocks (mock-up 28-tasks-edit): a labelled field, and the
// pill radios its choices are made of.

export function Field({
  label,
  children,
  note,
}: {
  label: string
  children: ReactNode
  note?: string
}) {
  return (
    <div className="bold-rj-field">
      <span className="bold-rj-label">{label}</span>
      {children}
      {note && <span className="bold-rj-hint">{note}</span>}
    </div>
  )
}

export function Choices<T extends string | number>({
  label,
  value,
  options,
  onPick,
}: {
  label: string
  value: T
  options: { id: T; label: string }[]
  onPick: (id: T) => void
}) {
  return (
    <div className="bold-rj-choices" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.id === value}
          onClick={() => onPick(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
