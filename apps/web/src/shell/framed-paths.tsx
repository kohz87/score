// Components kept from the removed classic shell (3.0.0) still name their old paths in links. Inside the bold frame
// `Link` and `useNavigate` here map those to their /b homes; the router redirects the same old addresses on load.
import { boldOneToOneLink } from '../bold/bold-links.ts'
import { createContext, forwardRef, useCallback, useContext } from 'react'
import { Link as RouterLink, useNavigate as useRouterNavigate } from 'react-router'
import type { Room } from '@score/contract'
import type { LinkProps, NavigateFunction, NavigateOptions, To } from 'react-router'

/** Provided by the bold shell around its Outlet. */
export type FrameRoom = Pick<Room, 'id' | 'kind' | 'role' | 'leadAgentId' | 'members' | 'everyone'>
export type BoldFrame = { look: 'light' | 'dark'; rooms?: readonly FrameRoom[] }
export const BoldFrameContext = createContext<BoldFrame | null>(null)

const SPLIT = /^([^?#]*)(.*)$/

/** Paths that move under `/b` as they are: the kept classic pages. */
const PREFIXED = ['/settings', '/team']

/** Watch is the replay on the agent's screen page (2.6.0). */
const WATCH = /^\/watch\/([^/]+)$/

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

/** 2.8.0: the workflow list and editor became the Recipes page; `/workflows[/:id]` maps there, query and hash kept. */
function recipesPath(path: string, rest: string): string | null {
  if (path === '/workflows') return `/b/recipes${rest}`
  if (path.startsWith('/workflows/')) return `/b/recipes/${path.slice('/workflows/'.length)}${rest}`
  return null
}

/**
 * The /b home of a classic path, or the path itself when it has none (Knowledge, Reports, Terminal…) or is already
 * under /b. Query and hash are kept, except where the destination has no use for them.
 */
export function toBoldPath(to: string, rooms: readonly FrameRoom[] = []): string {
  const [, path = '', rest = ''] = SPLIT.exec(to) ?? []
  if (!path.startsWith('/') || under(path, '/b')) return to
  // A chat room: the team room, an agent's one-to-one, or the room switcher's older room.
  if (under(path, '/chat')) return chatRoomPath(path, rooms)
  // The Workspace deep link has no /b page of its own: the agent's page is the nearest.
  const workspace = /^\/team\/([^/]+)\/workspace$/.exec(path)
  if (workspace) return `/b/team/${workspace[1]}`
  const recipes = recipesPath(path, rest)
  if (recipes) return recipes
  // A run opens in the room's Runs side panel (2.5.0); the query and #hash go with it.
  const run = /^\/runs\/([^/]+)$/.exec(path)
  if (run) {
    try {
      const [query = '', hash = ''] = rest.split('#')
      const params = new URLSearchParams(query)
      params.set('run', decodeURIComponent(run[1] ?? ''))
      return `/b?${params.toString()}${hash ? `#${hash}` : ''}`
    } catch {
      // A malformed %-escape: keep the raw path rather than throw while rendering a link.
      return to
    }
  }
  const watch = WATCH.exec(path)
  if (watch) return `/b/screen/${watch[1]}${rest}`
  if (PREFIXED.some((root) => under(path, root))) return `/b${path}${rest}`
  return to
}

function chatRoomPath(path: string, rooms: readonly FrameRoom[]): string {
  const id = path.split('/')[2]
  if (!id) return '/b'
  const roomId = decodeURIComponent(id)
  const room = rooms.find((item) => item.id === roomId)
  if (room?.role === 'team' && room.everyone !== false) return '/b'
  if (room && (room.role === 'direct' || room.kind === 'direct')) {
    const agentId = room.leadAgentId ?? room.members[0]
    if (agentId) return boldOneToOneLink(agentId)
  }
  // The room's own page reads `room`; one it can't find opens the team room.
  return `/b?room=${encodeURIComponent(roomId)}`
}

/** `/b?<extra>&<existing query>`: a /b address that keeps whatever query the old address carried. */
function boldRoot(extra: Record<string, string>, search: string, hash: string): string {
  const params = new URLSearchParams(extra)
  for (const [key, value] of new URLSearchParams(search))
    if (!params.has(key)) params.set(key, value)
  const query = params.toString()
  return `/b${query ? `?${query}` : ''}${hash}`
}

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/**
 * Where an old classic address goes (3.0.0: the classic shell is gone, so every one of its paths leads into the new
 * shell), or null for an address that is not an old classic one. Query and #hash are kept.
 */
export function classicRedirectFor(pathname: string, search: string, hash = ''): string | null {
  const recipes = recipesPath(pathname, `${search}${hash}`)
  if (recipes) return recipes
  const watch = WATCH.exec(pathname)
  if (watch) return `/b/screen/${watch[1]}${search}${hash}`
  const attempt = /^\/attempts\/([^/]+)$/.exec(pathname)
  if (attempt) return `/b/attempts/${attempt[1]}${search}${hash}`
  if (under(pathname, '/chat')) {
    const id = pathname.split('/')[2]
    const roomId = id ? decoded(id) : null
    return boldRoot(roomId ? { room: roomId } : {}, search, hash)
  }
  const member = /^\/team\/([^/]+)(?:\/workspace)?$/.exec(pathname)
  if (member) return `/b/team/${member[1]}${search}${hash}`
  if (pathname === '/team') return `/b/team${search}${hash}`
  if (under(pathname, '/knowledge')) {
    const note = pathname === '/knowledge' ? null : decoded(pathname.slice('/knowledge/'.length))
    return boldRoot(note ? { note } : { library: '1' }, search, hash)
  }
  if (pathname === '/reports') return `/b/settings/usage${search}${hash}`
  if (under(pathname, '/settings') || under(pathname, '/terminal'))
    return `/b${pathname}${search}${hash}`
  return null
}

export function useFramed(): BoldFrame | null {
  return useContext(BoldFrameContext)
}

function mapTo(to: To, frame: BoldFrame | null): To {
  if (!frame) return to
  if (typeof to === 'string') return toBoldPath(to, frame.rooms)
  if (to.pathname === undefined) return to
  const mapped = toBoldPath(to.pathname, frame.rooms)
  // A mapped path may carry its own query (a room), which then replaces the object's.
  const [pathname = mapped, query] = mapped.split('?')
  return query === undefined ? { ...to, pathname } : { ...to, pathname, search: `?${query}` }
}

/** Drop-in for react-router's `Link`: inside the bold frame a classic path goes to its /b home. */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function FramedLink(
  { to, ...rest },
  ref,
) {
  const frame = useFramed()
  return <RouterLink ref={ref} to={mapTo(to, frame)} {...rest} />
})

/** Drop-in for react-router's `useNavigate`, mapping the same way. */
export function useNavigate(): NavigateFunction {
  const navigate = useRouterNavigate()
  const frame = useFramed()
  const mapped = useCallback(
    (to: To | number, options?: NavigateOptions) =>
      typeof to === 'number' ? navigate(to) : navigate(mapTo(to, frame), options),
    [navigate, frame],
  )
  // The overloads of NavigateFunction (a number or a To) are what `mapped` implements.
  return mapped as NavigateFunction
}
