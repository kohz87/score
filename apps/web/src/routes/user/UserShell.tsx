import { useCallback, useEffect, useState } from 'react'
import { Outlet } from 'react-router'
import { ResponsiveDrawer } from '../../components/ResponsiveDrawer.tsx'
import { useActivityFeed } from '../../live/use-activity.ts'
import { NotificationBridge } from '../../notifications/NotificationBridge.tsx'
import { UpdateBanner } from '../../pwa/UpdateBanner.tsx'
import { CommandPalette } from '../../shell/CommandPalette.tsx'
import { clearDeviceLook, lookStore } from '../../themes/look-store.ts'
import { useLook } from '../../themes/use-look.ts'
import { usePreview } from '../../themes/preview-context.ts'
import { useLayout } from '../../themes/layout.ts'
import '../chat/chat.css'
import { UserSidebar } from './UserSidebar.tsx'
import { useViewSwitch } from './ViewSwitch.tsx'
import './user.css'

/** The chat-first view (PLAN 8.4): a conversation list on the left, one conversation in the middle. */
export function UserShell() {
  // Listens from the start, so the status lines know what is going on even in a room opened later.
  useActivityFeed()
  const preview = usePreview()
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const [commandOpen, setCommandOpen] = useState(false)
  const closeCommand = useCallback(() => setCommandOpen(false), [])
  const { toAdmin, dialog } = useViewSwitch()
  // A theme from outside Score (imported or made in the Customizer) can rearrange or hide the sidebar and its avatar menu:
  // while one is on, the way back sits on the page. Score's own looks need no extra bar.
  const look = useLook()
  // (Decided once the theme list is known, so Score's own looks never flash the bar while it loads.)
  const outsideTheme =
    look.fromServer &&
    look.effectiveId !== null &&
    look.failure === null &&
    look.themes.find((item) => item.id === look.effectiveId)?.source !== 'builtin'
  useEffect(() => {
    // The Customizer's preview is a picture of this shell: its shortcuts belong to the page around it.
    if (preview) return
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen(true)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [preview])
  // The theme's room list position for this view (views.user overrides the shared setting).
  const roomList = useLayout().chat.roomList
  const sidebar = (
    <ResponsiveDrawer
      label="Conversations"
      className="user-sidebar"
      open={open}
      onClose={close}
      always={roomList === 'hidden-until-opened'}
    >
      <UserSidebar />
    </ResponsiveDrawer>
  )
  return (
    <div className="user-view">
      {roomList !== 'right' && sidebar}
      <div className="user-main">
        {!preview && outsideTheme && (
          // The way back from a custom theme (design §4.5), on the page in every layout: shown only while a custom look
          // is on (user.css), protected, and not part of the sidebar a theme can hide or the drawer that is closed.
          <nav className="user-way-back" aria-label="Way back" data-protected="flex">
            <button
              type="button"
              className="user-way-link"
              aria-haspopup="dialog"
              aria-keyshortcuts="Meta+K Control+K"
              onClick={() => setCommandOpen(true)}
            >
              Search or run a command
            </button>
            <button type="button" className="user-way-link" onClick={() => toAdmin('/now')}>
              Admin view
            </button>
            <button type="button" className="user-way-link" onClick={() => toAdmin('/settings')}>
              Settings
            </button>
            <button
              type="button"
              className="user-way-link look-reset"
              onClick={() => {
                clearDeviceLook()
                lookStore.setFailure(null)
              }}
            >
              Reset look
            </button>
          </nav>
        )}
        <header className="user-top">
          <button
            type="button"
            className="user-menu-button"
            data-protected="inline-flex"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path
                d="M3 5 H15 M3 9 H15 M3 13 H11"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
            Conversations
          </button>
        </header>
        <Outlet />
      </div>
      {roomList === 'right' && sidebar}
      {!preview && <NotificationBridge />}
      {!preview && <UpdateBanner />}
      {commandOpen && <CommandPalette onClose={closeCommand} userView={{ toAdmin }} />}
      {dialog}
    </div>
  )
}
