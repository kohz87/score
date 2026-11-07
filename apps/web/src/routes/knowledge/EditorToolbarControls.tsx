import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
/** `Mod-Shift-x` -> `Ctrl+Shift+X` (⌘ on a Mac). */
export function shortcutLabel(keys: string): string {
  return keys
    .split('-')
    .map((part) =>
      part === 'Mod'
        ? isMac()
          ? '⌘'
          : 'Ctrl'
        : part.length === 1
          ? part.toUpperCase()
          : part === 'Alt' && isMac()
            ? '⌥'
            : part,
    )
    .join('+')
}

type ToolProps = {
  id: string
  label: string
  shortcut?: string
  icon: ReactNode
  text?: string
  pressed?: boolean
  disabled?: boolean
  expanded?: boolean
  controls?: string
  onRun: (event: MouseEvent<HTMLButtonElement>) => void
}

export function Tool({
  id,
  label,
  shortcut,
  icon,
  text,
  pressed,
  disabled,
  expanded,
  controls,
  onRun,
}: ToolProps) {
  const keys = shortcut ? shortcutLabel(shortcut) : null
  return (
    <button
      type="button"
      className="kn-tb-btn"
      data-tool={id}
      title={keys ? `${label} (${keys})` : label}
      aria-label={label}
      aria-keyshortcuts={shortcut?.replace('Mod', 'Control')}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      disabled={disabled}
      // Keep the caret and selection in the editor: the click is a command, not a focus change.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRun}
    >
      {icon}
      {text && <span className="kn-tb-text">{text}</span>}
    </button>
  )
}

export function Strip({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  // One tab stop for the whole strip; arrow keys move between its buttons.
  const [rover, setRover] = useState(0)
  const buttons = () =>
    Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  useEffect(() => {
    const list = buttons()
    list.forEach(
      (button, index) => (button.tabIndex = index === Math.min(rover, list.length - 1) ? 0 : -1),
    )
  })
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = buttons()
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    if (at === -1) return
    let next: number
    if (event.key === 'ArrowRight') next = (at + 1) % list.length
    else if (event.key === 'ArrowLeft') next = (at - 1 + list.length) % list.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = list.length - 1
    else return
    event.preventDefault()
    setRover(next)
    list[next]!.focus()
  }
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={label}
      className={`kn-tb-strip${className ? ` ${className}` : ''}`}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        const at = buttons().indexOf(event.target as unknown as HTMLButtonElement)
        if (at !== -1) setRover(at)
      }}
    >
      {children}
    </div>
  )
}
