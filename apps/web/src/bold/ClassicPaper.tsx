import type { ReactNode } from 'react'
import { useFramed } from '../shell/framed-paths.tsx'
import './bold-runs.css'

/**
 * The kept classic cards (decisions, graph, log, step details) are drawn with the classic token set; this wrapper
 * gives them that, in the shell's look (never a forced one: a failing theme's contrast fallback keys its colours to the
 * page's look); a decision is marked by the amber outline instead.
 */
export function ClassicPaper({
  children,
  tone = 'surface',
}: {
  children: ReactNode
  tone?: 'surface' | 'for-you' | 'plain'
}) {
  const frame = useFramed()
  return (
    <div
      className="bold-run-classic"
      data-tone={tone}
      data-pack="score"
      data-theme={frame?.look ?? 'dark'}
    >
      {children}
    </div>
  )
}
