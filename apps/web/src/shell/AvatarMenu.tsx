import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../data/api.ts'
import { announceLogout, remoteTransport } from '../data/session.ts'
import { readTheme, saveTheme, themeChoices, type ThemeChoice } from '../data/theme.ts'

const themeLabels: Record<ThemeChoice, string> = { light: 'Light', dark: 'Dark', system: 'System' }

/** The avatar and its menu: theme, and (in remote mode) log this browser out. */
export function AvatarMenu({ placement = 'below' }: { placement?: 'below' | 'above' }) {
  const [open, setOpen] = useState(false)
  const [theme, setTheme] = useState<ThemeChoice>(readTheme)
  const [problem, setProblem] = useState('')
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        root.current?.querySelector('button')?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="avatar-menu" data-placement={placement} ref={root}>
      <button
        type="button"
        className="avatar"
        data-protected="any"
        aria-label="Your account"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Y
      </button>
      {open && (
        <div className="avatar-popover" role="menu" aria-label="Account">
          <div role="group" aria-label="Theme" className="avatar-theme">
            {themeChoices.map((choice) => (
              <button
                key={choice}
                type="button"
                role="menuitemradio"
                aria-checked={theme === choice}
                onClick={() => {
                  setTheme(choice)
                  saveTheme(choice)
                }}
              >
                {themeLabels[choice]}
              </button>
            ))}
          </div>
          {remoteTransport() !== undefined && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void apiFetch('session', { method: 'DELETE' }).then(announceLogout, () =>
                  setProblem('Couldn’t log out. Try again.'),
                )
              }}
            >
              Log out this browser
            </button>
          )}
          {problem && <p role="alert">{problem}</p>}
        </div>
      )}
    </div>
  )
}
