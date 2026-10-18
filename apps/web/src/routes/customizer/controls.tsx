import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
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

// ---------------------------------------------------------------------------------------------------------------

/**
 * A list whose rows can be dragged by their handle (pointer, touch) and moved by the keyboard: the arrow keys on a
 * focused handle, and whatever move buttons the row itself offers. `onMove` is told the old and new index.
 */
export function SortableList<T>({
  items,
  getId,
  label,
  handleLabel,
  onMove,
  renderItem,
}: {
  items: T[]
  getId: (item: T) => string
  label: string
  handleLabel: (item: T) => string
  onMove: (from: number, to: number) => void
  renderItem: (item: T, index: number, handle: ReactNode) => ReactNode
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const latest = useRef({ items, getId, onMove })
  useEffect(() => {
    latest.current = { items, getId, onMove }
  })

  function indexAt(y: number): number {
    const rows = [...(listRef.current?.children ?? [])]
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i]!.getBoundingClientRect()
      if (y < rect.top + rect.height / 2) return i
    }
    return rows.length - 1
  }
  function onPointerMove(event: PointerEvent, id: string) {
    if (dragging !== id) return
    const { items: current, getId: idOf, onMove: move } = latest.current
    const from = current.findIndex((item) => idOf(item) === id)
    const to = indexAt(event.clientY)
    if (from >= 0 && to >= 0 && from !== to) move(from, to)
  }
  function onKeyDown(event: KeyboardEvent, index: number) {
    if (event.key === 'ArrowUp' && index > 0) {
      event.preventDefault()
      onMove(index, index - 1)
    } else if (event.key === 'ArrowDown' && index < items.length - 1) {
      event.preventDefault()
      onMove(index, index + 1)
    }
  }
  return (
    <ul className="cz-sortable" ref={listRef} aria-label={label}>
      {items.map((item, index) => {
        const id = getId(item)
        const handle = (
          <button
            type="button"
            className="cz-grip"
            aria-label={`${handleLabel(item)}: drag, or press the up and down arrow keys`}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              setDragging(id)
            }}
            onPointerMove={(event) => onPointerMove(event, id)}
            onPointerUp={() => setDragging(null)}
            onPointerCancel={() => setDragging(null)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <svg width="12" height="18" viewBox="0 0 12 18" aria-hidden="true" fill="currentColor">
              <circle cx="3" cy="3" r="1.5" />
              <circle cx="9" cy="3" r="1.5" />
              <circle cx="3" cy="9" r="1.5" />
              <circle cx="9" cy="9" r="1.5" />
              <circle cx="3" cy="15" r="1.5" />
              <circle cx="9" cy="15" r="1.5" />
            </svg>
          </button>
        )
        return (
          <li key={id} className="cz-sortable-row" data-dragging={dragging === id || undefined}>
            {renderItem(item, index, handle)}
          </li>
        )
      })}
    </ul>
  )
}

/** The up and down buttons of a row: the keyboard route for every drag. */
export function MoveButtons({
  name,
  index,
  count,
  onMove,
}: {
  name: string
  index: number
  count: number
  onMove: (to: number) => void
}) {
  return (
    <span className="cz-move">
      <button
        type="button"
        className="cz-icon-btn"
        aria-label={`Move ${name} up`}
        disabled={index === 0}
        onClick={() => onMove(index - 1)}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m3 9 4-4 4 4" />
        </svg>
      </button>
      <button
        type="button"
        className="cz-icon-btn"
        aria-label={`Move ${name} down`}
        disabled={index === count - 1}
        onClick={() => onMove(index + 1)}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m3 5 4 4 4-4" />
        </svg>
      </button>
    </span>
  )
}
