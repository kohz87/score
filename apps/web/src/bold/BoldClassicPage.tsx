import type { ReactNode } from 'react'
import { useFramed } from '../shell/framed-paths.tsx'
import './bold-classic.css'

/**
 * A kept classic page (workflows, runs, Watch) inside the bold frame (decision 123, 2.0.2). The
 * wrapper wears the classic token set in the shell's current look (`data-pack="score"` carries both), so the page keeps
 * the colours and fonts it was drawn with; the bold tokens stop at its edge.
 */
export function BoldClassicPage({ children }: { children: ReactNode }) {
  const frame = useFramed()
  return (
    <div className="bold-classic-page" data-pack="score" data-theme={frame?.look ?? 'dark'}>
      {children}
    </div>
  )
}
