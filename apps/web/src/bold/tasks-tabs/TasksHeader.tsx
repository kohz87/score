import type { ReactNode } from 'react'
import { TasksTabs } from './TasksTabs.tsx'

/**
 * The one header of every Tasks page (Board, Repeating, Recipes): "Tasks", the page's own action, and the three views on
 * the same first row, so the views never move when switching between them (owner, 2026-11-10). The page's line goes
 * under it.
 */
export function TasksHeader({
  action,
  aside,
  children,
}: {
  /** The page's own button ("New task", "New repeating job"). */
  action?: ReactNode
  /** What sits just before the views (the board's "needs you"). */
  aside?: ReactNode
  /** The page's line under the header. */
  children?: ReactNode
}) {
  return (
    <header className="bold-th">
      <div className="bold-th-row">
        <h1>Tasks</h1>
        {action}
        <span className="bold-th-gap" aria-hidden />
        {aside}
        <TasksTabs />
      </div>
      {children ? <p className="bold-th-sub">{children}</p> : null}
    </header>
  )
}
