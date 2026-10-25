// Kept classic pages (workflows, runs, Watch, the Customizer) also open inside the bold shell (decision 123, 2.0.2).
// Their links name the classic paths; inside the bold frame `Link` and `useNavigate` here map them to their /b homes.
import { createContext, forwardRef, useCallback, useContext } from 'react'
import { Link as RouterLink, useNavigate as useRouterNavigate } from 'react-router'
import type { LinkProps, NavigateFunction, NavigateOptions, To } from 'react-router'

/** Provided by the bold shell around its Outlet; null in the classic shell. */
export type BoldFrame = { look: 'light' | 'dark' }
export const BoldFrameContext = createContext<BoldFrame | null>(null)

const SPLIT = /^([^?#]*)(.*)$/

/** Paths that move under `/b` as they are: the kept classic pages. */
const PREFIXED = ['/workflows', '/runs', '/watch', '/settings', '/team']

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

/**
 * The /b home of a classic path, or the path itself when it has none (Knowledge, Reports, Terminal…) or is already
 * under /b. Query and hash are kept, except where the destination has no use for them.
 */
export function toBoldPath(to: string): string {
  const [, path = '', rest = ''] = SPLIT.exec(to) ?? []
  if (!path.startsWith('/') || under(path, '/b')) return to
  // Chat rooms live in the team room now.
  if (under(path, '/chat')) return '/b'
  // The Workspace deep link has no /b page of its own: the agent's page is the nearest.
  const workspace = /^\/team\/([^/]+)\/workspace$/.exec(path)
  if (workspace) return `/b/team/${workspace[1]}`
  if (PREFIXED.some((root) => under(path, root))) return `/b${path}${rest}`
  return to
}

/**
 * Where the bold shell sends someone who opens an old classic path: the /b home for the kept pages, null otherwise
 * (the classic shell keeps serving everything else).
 */
export function boldRedirectFor(pathname: string, search: string, hash = ''): string | null {
  const keep = ['/workflows', '/runs', '/watch', '/settings/look/customize']
  if (!keep.some((root) => under(pathname, root))) return null
  return `/b${pathname}${search}${hash}`
}

export function useFramed(): BoldFrame | null {
  return useContext(BoldFrameContext)
}

function mapTo(to: To, framed: boolean): To {
  if (!framed) return to
  if (typeof to === 'string') return toBoldPath(to)
  if (to.pathname === undefined) return to
  return { ...to, pathname: toBoldPath(to.pathname) }
}

/** Drop-in for react-router's `Link`: inside the bold frame a classic path goes to its /b home. */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function FramedLink(
  { to, ...rest },
  ref,
) {
  const framed = useFramed() !== null
  return <RouterLink ref={ref} to={mapTo(to, framed)} {...rest} />
})

/** Drop-in for react-router's `useNavigate`, mapping the same way. */
export function useNavigate(): NavigateFunction {
  const navigate = useRouterNavigate()
  const framed = useFramed() !== null
  const mapped = useCallback(
    (to: To | number, options?: NavigateOptions) =>
      typeof to === 'number' ? navigate(to) : navigate(mapTo(to, framed), options),
    [navigate, framed],
  )
  // The overloads of NavigateFunction (a number or a To) are what `mapped` implements.
  return mapped as NavigateFunction
}
