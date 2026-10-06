import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet } from 'react-router'
import { CommandPalette } from './CommandPalette.tsx'
import { TopBar } from './TopBar.tsx'

export function AppShell() {
  const [commandOpen, setCommandOpen] = useState(false)
  const commandButtonRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  const closeCommand = useCallback(() => {
    setCommandOpen(false)
  }, [])
  useEffect(() => {
    // Restore focus after the shell has stopped being inert.
    if (!commandOpen && wasOpen.current) commandButtonRef.current?.focus()
    wasOpen.current = commandOpen
  }, [commandOpen])
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen(true)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
  return (
    <div className="app-shell">
      <div inert={commandOpen} className="shell-content">
        <TopBar
          commandButtonRef={commandButtonRef}
          onOpenCommand={() => setCommandOpen(true)}
          commandOpen={commandOpen}
        />
        <main className="page-content">
          <Outlet />
        </main>
      </div>
      {commandOpen && <CommandPalette onClose={closeCommand} />}
    </div>
  )
}
