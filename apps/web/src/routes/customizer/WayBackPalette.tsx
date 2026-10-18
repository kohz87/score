import { useEffect, useState } from 'react'
import { CommandPalette } from '../../shell/CommandPalette.tsx'

/**
 * The full-screen Customizer sits outside both shells, so it has no menu or search button of its own. Ctrl+K (or ⌘K)
 * opens the same command palette the shells have: Settings among the destinations and "Reset look on this device" among
 * the commands, whatever the theme did to the page around it (cross-audit X7).
 */
export function WayBackPalette() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  return open ? <CommandPalette onClose={() => setOpen(false)} /> : null
}
