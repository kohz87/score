import type { Ref } from 'react'
import { MainNav } from './MainNav.tsx'

type TopBarProps = {
  commandButtonRef: Ref<HTMLButtonElement>
  onOpenCommand: () => void
  commandOpen: boolean
}

export function TopBar({ commandButtonRef, onOpenCommand, commandOpen }: TopBarProps) {
  return (
    <header className="top-bar">
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
        type="button"
        onClick={onOpenCommand}
        aria-haspopup="dialog"
        aria-expanded={commandOpen}
        aria-keyshortcuts="Meta+K Control+K"
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
      <div className="avatar" role="img" aria-label="You">
        Y
      </div>
    </header>
  )
}
