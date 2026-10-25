import { createContext } from 'react'

/**
 * 2.2.0 (decision 127): glyphs draw their eyes only inside the new shell. BoldShell (and the bold pairing page) provide
 * `true`; everywhere else the default keeps the classic shell's eyeless glyphs exactly as they were. A context rather
 * than a prop: some forty call sites render glyphs and only the shell knows which look is on.
 */
export const AgentFacesContext = createContext(false)
