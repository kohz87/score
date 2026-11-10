import { AgentFacesContext } from '../components/agent-faces-context.ts'
import { BoldShellFrame } from './BoldShellFrame.tsx'
import './tokens.css'
import './bold.css'
import './bold-theme.css'
import './bold-shape.css'

/**
 * The bold shell's frame (PLAN 11.3a): the top bar and, on a phone, the fixed tab bar. The room and its side panel are
 * the index child; Settings' Look choices apply to this whole shell, not only its own page.
 */
export function BoldShell() {
  // Decision 127: glyphs draw their eyes inside the new shell only.
  return (
    <AgentFacesContext value>
      <BoldShellFrame />
    </AgentFacesContext>
  )
}
