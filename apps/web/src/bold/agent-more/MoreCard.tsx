import { useId, useState, type ReactNode } from 'react'
import { ApiError } from '../../data/api.ts'

/** The server's own sentence when it sent one (pairing aside), else the card's fallback. */
export function problem(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.code === 'not_paired')
      return 'Pair this browser using the link in the server terminal first.'
    if (error.message.trim()) return error.message
  }
  return fallback
}

/** One compact More card: the prototype's `.card` with a 20px `h3`. */
export function MoreCard({
  id,
  title,
  count,
  danger,
  protectedKind,
  className = '',
  children,
}: {
  id?: string
  title: string
  count?: ReactNode
  danger?: boolean
  /** A card that asks the person to decide carries `data-protected`. */
  protectedKind?: 'block' | 'flex'
  className?: string
  children: ReactNode
}) {
  const heading = `${id ?? title.replace(/\W+/g, '-')}-title`
  return (
    <section
      className={`card bold-mc${danger ? ' bold-mc-danger' : ''} ${className}`.trim()}
      id={id}
      aria-labelledby={heading}
      {...(protectedKind ? { 'data-protected': protectedKind } : {})}
    >
      <h3 id={heading}>
        {title}
        {count !== undefined && <span className="small muted bold-mc-count"> {count}</span>}
      </h3>
      {children}
    </section>
  )
}

export function Fail({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="bold-mc-fail small">
      {children}
    </p>
  )
}

export const Loading = ({ what }: { what: string }) => (
  <p role="status" className="small muted">
    Loading {what}…
  </p>
)

/* Folding long cards (2.0.12). Expanded state lives for the page session only. */
const expandedKeys = new Set<string>()

function useExpanded(key: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => expandedKeys.has(key))
  return [
    open,
    () => {
      if (expandedKeys.has(key)) expandedKeys.delete(key)
      else expandedKeys.add(key)
      setOpen((value) => !value)
    },
  ]
}

function FoldButton({
  open,
  controls,
  all,
  onClick,
}: {
  open: boolean
  controls: string
  all: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="bold-fold-btn"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onClick}
    >
      {open ? 'Show less' : all}
    </button>
  )
}

/** Fold a long list by count: the first `limit` rows, then "Show all N". Inputs and decision buttons go outside. */
export function useFoldedList<T>(
  key: string,
  items: T[],
  limit = 6,
): { shown: T[]; toggle: ReactNode; id: string } {
  const [open, flip] = useExpanded(key)
  const id = useId()
  const folds = items.length > limit
  return {
    shown: folds && !open ? items.slice(0, limit) : items,
    id,
    toggle: folds ? (
      <FoldButton open={open} controls={id} all={`Show all ${items.length}`} onClick={flip} />
    ) : null,
  }
}
