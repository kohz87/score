// Kept classic pages (workflows, runs, Watch, the Customizer) also open inside the bold shell (decision 123, 2.0.2).
// Their links name the classic paths; inside the bold frame `Link` and `useNavigate` here map them to their /b homes.
import { boldOneToOneLink } from '../bold/bold-links.ts'
import { createContext, forwardRef, useCallback, useContext } from 'react'
import { Link as RouterLink, useNavigate as useRouterNavigate } from 'react-router'
import type { Room } from '@score/contract'
import type { LinkProps, NavigateFunction, NavigateOptions, To } from 'react-router'

/** Provided by the bold shell around its Outlet; null in the classic shell. */
export type FrameRoom = Pick<Room, 'id' | 'kind' | 'role' | 'leadAgentId' | 'members'>
export type BoldFrame = { look: 'light' | 'dark'; rooms?: readonly FrameRoom[] }
export const BoldFrameContext = createContext<BoldFrame | null>(null)

const SPLIT = /^([^?#]*)(.*)$/

/** Paths that move under `/b` as they are: the kept classic pages. */
const PREFIXED = ['/runs', '/settings', '/team']

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
  if (room?.role === 'team') return '/b'
  if (room && (room.role === 'direct' || room.kind === 'direct')) {
    const agentId = room.leadAgentId ?? room.members[0]
    if (agentId) return boldOneToOneLink(agentId)
  }
  // The room's own page reads `room`; one it can't find opens the team room.
  return `/b?room=${encodeURIComponent(roomId)}`
}

/**
 * Where the bold shell sends someone who opens an old classic path: the /b home for the kept pages, null otherwise
 * (the classic shell keeps serving everything else).
 */
export function boldRedirectFor(pathname: string, search: string, hash = ''): string | null {
  const recipes = recipesPath(pathname, `${search}${hash}`)
  if (recipes) return recipes
  const watch = WATCH.exec(pathname)
  if (watch) return `/b/screen/${watch[1]}${search}${hash}`
  const keep = ['/runs', '/terminal', '/settings/look/customize']
  if (!keep.some((root) => under(pathname, root))) return null
  return `/b${pathname}${search}${hash}`
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
