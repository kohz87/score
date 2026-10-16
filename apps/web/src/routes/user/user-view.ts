// Which front end this browser opens (PLAN 8.4, decisions 85 and 87). Per browser, never sent to the server.
export type View = 'admin' | 'user'

const VIEW_KEY = 'score.view'
const GUARD_KEY = 'score.view.guard'

export function readView(): View {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'user' ? 'user' : 'admin'
  } catch {
    return 'admin'
  }
}

export function saveView(view: View): void {
  try {
    if (view === 'user') window.localStorage.setItem(VIEW_KEY, 'user')
    else window.localStorage.removeItem(VIEW_KEY)
  } catch {
    // Blocked storage still switches for this visit.
  }
}

/** "Ask for the security password to open the admin view": a convenience for a shared screen, not access control. */
export function readGuard(): boolean {
  try {
    return window.localStorage.getItem(GUARD_KEY) === '1'
  } catch {
    return false
  }
}

export function saveGuard(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(GUARD_KEY, '1')
    else window.localStorage.removeItem(GUARD_KEY)
  } catch {
    // Blocked storage: the guard stays off.
  }
}

export const userRoomPath = (roomId: string) => `/u/rooms/${encodeURIComponent(roomId)}`

/** The user view's address for an admin chat address, or null when the path is not a room. */
export function userPathFor(path: string): string | null {
  const match = /^\/chat\/([^/?#]+)/.exec(path)
  return match ? `/u/rooms/${match[1]}` : null
}

const LAST_ROOM_KEY = 'score.view.lastRoom'

export function readLastRoom(): string | null {
  try {
    return window.localStorage.getItem(LAST_ROOM_KEY)
  } catch {
    return null
  }
}

export function saveLastRoom(roomId: string): void {
  try {
    window.localStorage.setItem(LAST_ROOM_KEY, roomId)
  } catch {
    // Without storage, /u simply opens the empty state.
  }
}
