import { useId, useState, type ReactNode } from 'react'

/**
 * The open state of a summary. A link that names its card (a hash, `initialOpen`) opens it, also when the page is
 * already showing and the link changes.
 */
export function useOpenState(wanted: boolean) {
  const [open, setOpen] = useState(wanted)
  // Adjusted during render (the React pattern for a prop that changes): no effect, no extra paint.
  const [last, setLast] = useState(wanted)
  if (wanted !== last) {
    setLast(wanted)
    if (wanted) setOpen(true)
  }
  return [open, setOpen] as const
}

/**
 * A summary that opens today's full card in place: the summary (a region named by its title) shows while the card is
 * closed, the card (with a Close button) while it is open. A summary with no `openLabel` has nothing more to open.
 * `protectedKind` marks a summary that asks the person to decide, as its full card does.
 */
export function OpenCard({
  open,
  onOpen,
  onClose,
  title,
  summary,
  openLabel,
  openName,
  protectedKind,
  children,
}: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  title: ReactNode
  summary: ReactNode
  openLabel?: string
  /** The open button's accessible name. */
  openName?: string
  protectedKind?: 'block' | 'flex'
  children: ReactNode
}) {
  const titleId = useId()
  if (open)
    return (
      <div className="bold-open-card">
        {children}
        <button type="button" className="btn sm ghost" onClick={onClose}>
          Close
        </button>
      </div>
    )
  return (
    <section
      className="bold-agent-summary bold-agent-tile"
      aria-labelledby={titleId}
      {...(protectedKind ? { 'data-protected': protectedKind } : {})}
    >
      <h3 id={titleId}>{title}</h3>
      <div className="bold-agent-summary-text">{summary}</div>
      {openLabel && (
        <button type="button" className="btn sm" aria-label={openName} onClick={onOpen}>
          {openLabel}
        </button>
      )}
    </section>
  )
}
