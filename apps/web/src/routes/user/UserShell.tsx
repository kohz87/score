import { useCallback, useState } from 'react'
import { Outlet } from 'react-router'
import { ResponsiveDrawer } from '../../components/ResponsiveDrawer.tsx'
import { useActivityFeed } from '../../live/use-activity.ts'
import { NotificationBridge } from '../../notifications/NotificationBridge.tsx'
import { UpdateBanner } from '../../pwa/UpdateBanner.tsx'
import { useLayout } from '../../themes/layout.ts'
import '../chat/chat.css'
import { UserSidebar } from './UserSidebar.tsx'
import './user.css'

/** The chat-first view (PLAN 8.4): a conversation list on the left, one conversation in the middle. */
export function UserShell() {
  // Listens from the start, so the status lines know what is going on even in a room opened later.
  useActivityFeed()
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
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
        <header className="user-top">
          <button
            type="button"
            className="user-menu-button"
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
      <NotificationBridge />
      <UpdateBanner />
    </div>
  )
}
