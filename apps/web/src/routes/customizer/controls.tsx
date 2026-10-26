import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ThemeColorSchema } from '@score/contract'
import { parseColor } from '../../themes/color.ts'

// The small controls the Customizer's sections are made of. Every one has a name for assistive technology and works
// from the keyboard; the drag handles in SortableList have the move buttons of their rows as the keyboard route.

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  const id = useId()
  return (
    <div className="cz-field" role="group" aria-labelledby={id}>
      <span className="cz-field-label" id={id}>
        {label}
      </span>
      {hint && <span className="cz-field-hint">{hint}</span>}
      {children}
    </div>
  )
}

export type Option<T extends string> = { value: T; label: string }

/** A choice among a few words: a radio group that moves with the arrow keys. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  labelledBy,
}: {
  label?: string
  labelledBy?: string
  value: T
  options: Option<T>[]
  onChange: (value: T) => void
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const selected = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  )
  function onKeyDown(event: KeyboardEvent, index: number) {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (!step) return
    event.preventDefault()
    const next = (index + step + options.length) % options.length
    onChange(options[next]!.value)
    refs.current[next]?.focus()
  }
  return (
    <div
      className="cz-seg"
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => {
            refs.current[index] = element
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={index === selected ? 0 : -1}
          className="cz-seg-option"
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** A choice that can also be left alone, which means Score's own: the value is undefined then. */
export function OptionalSegmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T | undefined
  options: Option<T>[]
  onChange: (value: T | undefined) => void
}) {
  return (
    <Segmented<T | ''>
      label={label}
      value={value ?? ''}
      options={[{ value: '', label: 'Score’s' }, ...options]}
      onChange={(next) => onChange(next === '' ? undefined : next)}
    />
  )
}

export function Slider({
  label,
  value,
  min,
  max,
  unit,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  unit?: string
  onChange: (value: number) => void
}) {
  return (
    <label className="cz-slider">
      <span className="cz-slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>
        {value}
        {unit ?? ''}
      </output>
    </label>
  )
}

function hexOf(value: string): string | null {
  const rgba = parseColor(value)
  if (!rgba) return null
  const part = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${part(rgba[0])}${part(rgba[1])}${part(rgba[2])}`
}

/** A colour: the picker, the text (hex, rgb(), hsl(), oklch()), and the way back to Score's own value. */
export function ColorField({
  label,
  hint,
  value,
  fallback,
  warning,
  onChange,
  onReset,
}: {
  label: string
  hint: string
  /** What the draft sets, or undefined while it uses Score's. */
  value: string | undefined
  /** Score's own value, shown while the draft sets none. */
  fallback: string
  warning?: string
  onChange: (value: string) => void
  onReset: () => void
}) {
  const shown = value ?? fallback
  const [text, setText] = useState(shown)
  const [problem, setProblem] = useState(false)
  const editing = useRef(false)
  useEffect(() => {
    if (!editing.current) setText(shown)
  }, [shown])
  const hint1 = useId()
  const picker = hexOf(shown) ?? '#000000'
  return (
    <div className="cz-color" data-set={value !== undefined || undefined}>
      <input
        type="color"
        className="cz-color-picker"
        aria-label={label}
        aria-describedby={hint1}
        value={picker}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="cz-color-text">
        <span className="cz-color-name">{label}</span>
        <span className="cz-color-hint" id={hint1}>
          {hint}
        </span>
      </div>
      <input
        type="text"
        className="cz-color-input"
        aria-label={`${label}, colour value`}
        aria-invalid={problem || undefined}
        spellCheck={false}
        autoComplete="off"
        value={text}
        onFocus={() => {
          editing.current = true
        }}
        onBlur={() => {
          editing.current = false
          setProblem(false)
          setText(value ?? fallback)
        }}
        onChange={(event) => {
          const next = event.target.value.trim()
          setText(event.target.value)
          if (ThemeColorSchema.safeParse(next).success && parseColor(next)) {
            setProblem(false)
            onChange(next)
          } else setProblem(true)
        }}
      />
      <button
        type="button"
        className="cz-link"
        disabled={value === undefined}
        aria-label={`Use Score’s ${label.toLowerCase()}`}
        onClick={onReset}
      >
        Reset
      </button>
      {problem && (
        <p className="cz-color-problem" role="alert">
          Use a hex colour like #1a2b3c, or rgb(), hsl() or oklch().
        </p>
      )}
      {warning && !problem && <p className="cz-color-warning">{warning}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    ref.current
      ?.querySelector<HTMLElement>(
        'input:not([type=hidden]), select, textarea, button:not(:disabled)',
      )
      ?.focus()
    return () => opener?.focus?.()
  }, [])
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (event.key === 'Tab') {
      const controls = [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href]',
        ) ?? []),
      ]
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
  }
  return (
    <div
      className="cz-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        className="cz-modal"
        data-wide={wide || undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  )
}
