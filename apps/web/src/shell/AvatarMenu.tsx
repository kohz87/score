import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../data/api.ts'
import { announceLogout, remoteTransport } from '../data/session.ts'
import { readTheme, saveTheme, themeChoices, type ThemeChoice } from '../data/theme.ts'
import { useViewSwitch } from '../routes/user/ViewSwitch.tsx'

const themeLabels: Record<ThemeChoice, string> = { light: 'Light', dark: 'Dark', system: 'System' }

/** The avatar and its menu, in both views: switch view, theme, and (in remote mode) log this browser out. */
export function AvatarMenu({
  view,
  placement = 'below',
}: {
  view: 'admin' | 'user'
  placement?: 'below' | 'above'
}) {
  const [open, setOpen] = useState(false)
  const [theme, setTheme] = useState<ThemeChoice>(readTheme)
  const [problem, setProblem] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const { toUser, toAdmin, dialog } = useViewSwitch()
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
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Y
      </button>
      {open && (
        <div className="avatar-popover" role="menu" aria-label="Account">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              if (view === 'admin') toUser()
              else toAdmin()
            }}
          >
            {view === 'admin' ? 'Switch to user view' : 'Switch to admin view'}
          </button>
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
      {dialog}
    </div>
  )
}
