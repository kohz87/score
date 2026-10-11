import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet } from 'react-router'
import { CommandPalette } from './CommandPalette.tsx'
import { NotificationBridge } from '../notifications/NotificationBridge.tsx'
import { UpdateBanner } from '../pwa/UpdateBanner.tsx'
import { NavDrawer } from './NavDrawer.tsx'
import { useTerminalAvailable } from './TerminalButton.tsx'
import { TopBar } from './TopBar.tsx'
import { useActivityFeed } from '../live/use-activity.ts'

export function AppShell() {
  // Listens from the start, so the status lines know what is going on even on a page opened later.
  useActivityFeed()
  const [commandOpen, setCommandOpen] = useState(false)
  const commandButtonRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const menuWasOpen = useRef(false)
  const terminalOffered = useTerminalAvailable()
  const closeMenu = useCallback(() => {
    setMenuOpen(false)
  }, [])
  const closeCommand = useCallback(() => {
    setCommandOpen(false)
  }, [])
  useEffect(() => {
    // Restore focus after the shell has stopped being inert.
    if (!commandOpen && wasOpen.current) commandButtonRef.current?.focus()
    wasOpen.current = commandOpen
  }, [commandOpen])
  useEffect(() => {
    if (!menuOpen && menuWasOpen.current) menuButtonRef.current?.focus()
    menuWasOpen.current = menuOpen
  }, [menuOpen])
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
      <div inert={commandOpen || menuOpen} className="shell-content">
        <TopBar
          commandButtonRef={commandButtonRef}
          onOpenCommand={() => setCommandOpen(true)}
          commandOpen={commandOpen}
          menuButtonRef={menuButtonRef}
          onToggleMenu={() => setMenuOpen((open) => !open)}
          menuOpen={menuOpen}
          terminalOffered={terminalOffered}
        />
        <main className="page-content">
          <Outlet />
        </main>
      </div>
      <NavDrawer open={menuOpen} onClose={closeMenu} terminalOffered={terminalOffered} />
      <NotificationBridge />
      <UpdateBanner />
      {commandOpen && <CommandPalette onClose={closeCommand} />}
    </div>
  )
}
