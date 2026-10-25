import type { Ref } from 'react'
import { NAV_DRAWER_ID } from './NavDrawer.tsx'
import { MainNav, NeedsYouDot } from './MainNav.tsx'
import { useLayout } from '../themes/layout.ts'
import { TerminalButton } from './TerminalButton.tsx'
import { AvatarMenu } from './AvatarMenu.tsx'

type TopBarProps = {
  commandButtonRef: Ref<HTMLButtonElement>
  onOpenCommand: () => void
  commandOpen: boolean
  menuButtonRef: Ref<HTMLButtonElement>
  onToggleMenu: () => void
  menuOpen: boolean
  terminalOffered: boolean
}

export function TopBar({
  commandButtonRef,
  onOpenCommand,
  commandOpen,
  menuButtonRef,
  onToggleMenu,
  menuOpen,
  terminalOffered,
}: TopBarProps) {
  // The launcher layout hides the links, so the Needs-you marker rides on the menu button.
  const launcher = useLayout().nav === 'launcher'
  return (
    <header className="top-bar">
      <span className="menu-slot">
        <button
          ref={menuButtonRef}
          className="menu-trigger"
          data-protected="any"
          type="button"
          onClick={onToggleMenu}
          aria-expanded={menuOpen}
          aria-controls={NAV_DRAWER_ID}
          aria-label="Menu"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path
              d="M3 5 H15 M3 9 H15 M3 13 H15"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
        {launcher && !menuOpen && (
          <span className="menu-slot-badge">
            <NeedsYouDot />
          </span>
        )}
      </span>
      <div className="brand">
        <svg
          className="brand-mark"
          width="30"
          height="30"
          viewBox="0 0 30 30"
          fill="none"
          aria-hidden="true"
        >
          <rect x="1" y="1" width="28" height="28" rx="9" />
          <path className="brand-violet" d="M7 10 H15" />
          <path className="brand-jade" d="M11 15 H23" />
          <path className="brand-saffron" d="M9 20 H18" />
        </svg>
        <span className="wordmark">score</span>
      </div>
      <span className="brand-subtitle">for Hermes</span>
      <MainNav />
      <span className="top-bar-spacer" />
      <button
        ref={commandButtonRef}
        className="command-trigger"
        data-protected="any"
        type="button"
        onClick={onOpenCommand}
        aria-haspopup="dialog"
        aria-expanded={commandOpen}
        aria-keyshortcuts="Meta+K Control+K"
        aria-label="Search or run a command"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="M10.5 10.5 L14 14"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
        <span>Search or run a command</span>
        <kbd className="command-shortcut">⌘K</kbd>
      </button>
      {/* One row at the foot of a side rail; no box of its own in the top bar (display: contents). */}
      <div className="top-bar-actions">
        <TerminalButton offered={terminalOffered} />
        <AvatarMenu />
      </div>
    </header>
  )
}
