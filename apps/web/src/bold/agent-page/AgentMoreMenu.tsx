import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyEvent,
  type ReactNode,
} from 'react'

/** The ⋯ menu: a button that opens a small list of links and actions; Escape or a click outside closes it. */
export function AgentMoreMenu({ children }: { children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      root.current?.querySelector('button')?.focus()
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  // Opening the menu moves focus to its first item; the arrow keys, Home and End move between items.
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
  }, [open])
  function move(event: ReactKeyEvent<HTMLDivElement>) {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role=menuitem]')]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next =
      event.key === 'ArrowDown'
        ? (at + 1) % items.length
        : event.key === 'ArrowUp'
          ? (at - 1 + items.length) % items.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : -1
    if (next < 0) return
    event.preventDefault()
    items[next]?.focus()
  }
  return (
    <span className="bold-agent-more" ref={root}>
      <button
        type="button"
        className="bold-agent-more-btn"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ⋯
      </button>
      {open && (
        <div
          className="bold-agent-more-list"
          role="menu"
          aria-label="More actions"
          onKeyDown={move}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </span>
  )
}
