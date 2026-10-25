import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { NavLink, useLocation } from 'react-router'
import { prefersReducedMotion } from '../data/use-media.ts'
import { useLayout, useMenu } from '../themes/layout.ts'
import { HermesCheckDot, NeedsYouDot } from './MainNav.tsx'

export const NAV_DRAWER_ID = 'nav-drawer'

type NavDrawerProps = { open: boolean; onClose: () => void; terminalOffered: boolean }

// Below 1024 px the destinations live here instead of in the top bar. It mounts while open (and while the exit
// animation runs), so the page behind never has two "Main" navigations in the tab order.
export function NavDrawer({ open, onClose, terminalOffered }: NavDrawerProps) {
  const [shown, setShown] = useState(open)
  const panelRef = useRef<HTMLElement>(null)
  const { pathname } = useLocation()
  const menu = useMenu()
  const dotOn = menu[0]?.path
  // The launcher layout opens this drawer at every width; the others only below the desktop breakpoint.
  const persistent = useLayout().nav === 'launcher'
  const pairing = pathname === '/pair'
  if (open && !shown) setShown(true)
  const closing = shown && !open
  useEffect(() => {
    if (!closing) return
    const reduce = prefersReducedMotion()
    const timer = window.setTimeout(() => setShown(false), reduce ? 0 : 220)
    return () => window.clearTimeout(timer)
  }, [closing])
  useEffect(() => {
    if (!open) return
    panelRef.current?.querySelector<HTMLElement>('[aria-current="page"], a[href]')?.focus()
    document.body.classList.add('scroll-locked')
    return () => document.body.classList.remove('scroll-locked')
  }, [open])
  // Close on navigation (not on the first render) and when the window grows past the drawer's breakpoint.
  const lastPath = useRef(pathname)
  useEffect(() => {
    if (lastPath.current !== pathname) onClose()
    lastPath.current = pathname
  }, [pathname, onClose])
  useEffect(() => {
    if (!open || persistent) return
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(min-width: 1024px)')
    const onChange = () => {
      if (query.matches) onClose()
    }
    // Also now: the launcher layout going away (a reset, another device's theme) can leave the drawer open at a width
    // where it is not shown, with the page behind it inert.
    onChange()
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [open, persistent, onClose])
  if (!shown) return null
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'Tab') {
      const controls = panelRef.current?.querySelectorAll<HTMLElement>('a[href], button')
      const first = controls?.[0]
      const last = controls?.[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
  }
  return (
    <div className={`nav-drawer${closing ? ' nav-drawer--closing' : ''}`}>
      <div className="nav-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        ref={panelRef}
        id={NAV_DRAWER_ID}
        className="nav-drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        onKeyDown={onKeyDown}
      >
        <div className="nav-drawer-head">
          <span className="wordmark">score</span>
          <button
            className="nav-drawer-close"
            type="button"
            onClick={onClose}
            aria-label="Close menu"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <nav aria-label="Pages" className="nav-drawer-nav">
          {menu.map(({ path, title, name }) => (
            <div key={path} className="nav-drawer-group">
              <NavLink
                to={path}
                className="nav-drawer-link"
                aria-label={name !== undefined && name !== title ? name : undefined}
                // Settings is the way back from a theme (gate #8): no theme rule reaches it.
                {...(path === '/settings' ? { 'data-protected': 'raised' } : {})}
              >
                {title}
                {path === dotOn && !pairing && <NeedsYouDot />}
                {path === '/settings' && !pairing && <HermesCheckDot />}
              </NavLink>
            </div>
          ))}
          {terminalOffered && (
            <NavLink to="/terminal" className="nav-drawer-link">
              Terminal
            </NavLink>
          )}
        </nav>
      </aside>
    </div>
  )
}
