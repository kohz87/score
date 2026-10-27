import { useId } from 'react'

/**
 * The Effort choice (3.9.0): "Default" sends nothing, so the model's or CLI's own default applies. A value that isn't in
 * the list (set by hand in Hermes) stays selectable as "Custom: x" until the person picks something else.
 */
export function EffortSelect({
  value,
  levels,
  onChange,
  label = 'Effort',
}: {
  /** '' = Default. */
  value: string
  levels: readonly string[]
  onChange: (value: string) => void
  label?: string
}) {
  const id = useId()
  return (
    <label className="ms-field" htmlFor={id}>
      {label}
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Default</option>
        {value !== '' && !levels.includes(value) && <option value={value}>Custom: {value}</option>}
        {levels.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
    </label>
  )
}
