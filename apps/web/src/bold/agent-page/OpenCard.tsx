import type { ReactNode } from 'react'

/**
 * A summary that opens today's full card in place: the summary shows while the card is closed, the card (with a
 * Close button) while it is open. `id` is the card's own id, so a link to it lands on the open card.
 */
export function OpenCard({
  open,
  onOpen,
  onClose,
  title,
  summary,
  openLabel,
  openName,
  children,
}: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  title: ReactNode
  summary: ReactNode
  openLabel: string
  /** The open button's accessible name. */
  openName: string
  children: ReactNode
}) {
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
    <div className="bold-agent-summary">
      <h3>{title}</h3>
      <div className="bold-agent-summary-text">{summary}</div>
      <button type="button" className="btn sm" aria-label={openName} onClick={onOpen}>
        {openLabel}
      </button>
    </div>
  )
}
