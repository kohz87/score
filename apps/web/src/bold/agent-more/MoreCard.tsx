import type { ReactNode } from 'react'

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
