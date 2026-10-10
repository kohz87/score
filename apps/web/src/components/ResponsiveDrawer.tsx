import { useEffect, useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useLocation } from 'react-router'
import { NARROW_QUERY, useMediaQuery } from '../data/use-media.ts'
import './responsive-drawer.css'

type ResponsiveDrawerProps = {
  label: string
  className?: string
  open: boolean
  onClose: () => void
  /** Stays a normal block even on narrow screens (for example the conversation list when no room is open). */
  inline?: boolean
  as?: 'aside' | 'nav'
  children: ReactNode
}

/**
 * A region that is an ordinary sidebar on desktop and an off-canvas drawer on phone and tablet. It stays mounted, so
 * its state survives; closed on a narrow screen it is hidden from the tab order and the accessibility tree.
 */
export function ResponsiveDrawer({
  label,
  className = '',
  open,
  onClose,
  inline = false,
  as: Tag = 'aside',
  children,
}: ResponsiveDrawerProps) {
  const narrow = useMediaQuery(NARROW_QUERY)
  const modal = narrow && !inline && open
  const panelRef = useRef<HTMLElement>(null)
  const { pathname } = useLocation()
  const lastPath = useRef(pathname)
  useEffect(() => {
    if (lastPath.current !== pathname) onClose()
    lastPath.current = pathname
  }, [pathname, onClose])
  useEffect(() => {
    if (!modal) return
    const opener = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    ;(panel?.querySelector<HTMLElement>('a[href], button:not([disabled]), input') ?? panel)?.focus()
    document.body.classList.add('scroll-locked')
    return () => {
      document.body.classList.remove('scroll-locked')
      opener?.focus()
    }
  }, [modal])
  useEffect(() => {
    if (open && !narrow) onClose()
  }, [open, narrow, onClose])
  useEffect(() => {
    if (!modal) return
    function onEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [modal, onClose])
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!modal) return
    if (event.key === 'Tab') {
      const controls = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input') ??
          [],
      )
      const first = controls[0]
      const last = controls[controls.length - 1]
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
    <>
      {modal && <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />}
      <Tag
        ref={panelRef}
        aria-label={label}
        className={`responsive-drawer ${className}${open ? ' is-open' : ''}${inline ? ' is-inline' : ''}`}
        role={modal ? 'dialog' : undefined}
        tabIndex={modal ? -1 : undefined}
        aria-modal={modal ? true : undefined}
        onKeyDown={onKeyDown}
      >
        {children}
      </Tag>
    </>
  )
}
