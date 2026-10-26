import { Outlet, redirect, RouterProvider } from 'react-router'
import type { DataRouter, RouteObject } from 'react-router'
import { BoldTerminalPage } from './bold/BoldTerminal.tsx'
import { classicRedirectFor } from './shell/framed-paths.tsx'
import { BoldHome } from './bold/BoldHome.tsx'
import { BoldShell } from './bold/BoldShell.tsx'
import { BoldAgentPage } from './bold/BoldAgent.tsx'
import { BoldAttemptPage } from './bold/BoldAttempt.tsx'
import { BoldScreenPage } from './bold/BoldScreen.tsx'
import { BoldSettings } from './bold/BoldSettings.tsx'
import { BoldTeam } from './bold/BoldTeam.tsx'
import { PairPage, pairBrowser } from './routes/pair/PairPage.tsx'
import { BoldRecipesPage } from './bold/BoldRecipes.tsx'

function keepSearch(request: Request, path: string) {
  return `${path}${new URL(request.url).search}`
}

/**
 * A loader's request never carries the #hash. On the first load the browser's address is the one being opened, so its
 * hash is the one to keep; on a later navigation the address is still the old page's, whose hash must not be borrowed.
 */
export function hashOf(
  url: URL,
  here: Pick<Location, 'pathname' | 'search' | 'hash'> = window.location,
) {
  if (url.hash) return url.hash
  return here.pathname === url.pathname && here.search === url.search ? here.hash : ''
}

/** A redirect that keeps the query and the #hash (a loader's request has no hash of its own; see hashOf). */
function keepAll(request: Request, path: string) {
  const url = new URL(request.url)
  return `${path}${url.search}${hashOf(url)}`
}

/** The new shell's address for an old classic one (3.0.0: the classic shell is gone), query and hash kept. */
function classicLoader({ request }: { request: Request }) {
  const url = new URL(request.url)
  const target = classicRedirectFor(url.pathname, url.search, hashOf(url))
  return redirect(target ?? '/b')
}

/** A run's old addresses (`/runs/:id`, `/b/runs/:id`, `/now/flow/:id`) open it in the Runs side panel (2.5.0). */
function runRedirect({ request, params }: { request: Request; params: { briefId?: string } }) {
  const url = new URL(request.url)
  const search = new URLSearchParams(url.search)
  search.set('run', params.briefId ?? '')
  return redirect(`/b?${search.toString()}${hashOf(url)}`)
}

/** Every address the classic shell served, each of which now leads into the new shell (see classicRedirectFor). */
const CLASSIC_PATHS = [
  '/chat',
  '/chat/*',
  '/team',
  '/team/*',
  '/knowledge',
  '/knowledge/*',
  '/reports',
  '/settings',
  '/settings/*',
  '/terminal',
  '/watch/:agentId',
  '/attempts/:attemptId',
]

export const appRoutes: RouteObject[] = [
  {
    Component: Outlet,
    children: [
      // 11.3a: the bold shell has its own prefix and frame; screens inside it land in later tasks.
      {
        path: '/b',
        Component: BoldShell,
        HydrateFallback: BoldShell,
        children: [
          { index: true, Component: BoldHome },
          { path: 'team', Component: BoldTeam },
          { path: 'team/:agentId', Component: BoldAgentPage },
          { path: 'screen/:agentId', Component: BoldScreenPage },
          { path: 'recipes', Component: BoldRecipesPage },
          { path: 'recipes/:workflowId', Component: BoldRecipesPage },
          {
            path: 'workflows',
            loader: ({ request }) => redirect(keepAll(request, '/b/recipes')),
          },
          {
            path: 'workflows/:workflowId',
            loader: ({ request, params }) =>
              redirect(keepAll(request, `/b/recipes/${params.workflowId ?? ''}`)),
          },
          { path: 'runs/:briefId', loader: runRedirect },
          // 2.6.0: Watch is the replay on the agent's screen page.
          {
            path: 'watch/:agentId',
            loader: ({ request, params }) =>
              redirect(keepSearch(request, `/b/screen/${params.agentId ?? ''}`)),
          },
          { path: 'terminal', Component: BoldTerminalPage },
          { path: 'attempts/:attemptId', Component: BoldAttemptPage },
          // Decision 131 E: the Customizer lives inside Settings › Look; BoldSettings loads it.
          { path: 'settings/look/customize', Component: BoldSettings },
          { path: 'settings/look/customize/:themeId', Component: BoldSettings },
          { path: 'settings', Component: BoldSettings },
          { path: 'settings/:section', Component: BoldSettings },
          { path: '*', loader: () => redirect('/b') },
        ],
      },
      { index: true, loader: () => redirect('/b') },
      ...CLASSIC_PATHS.map((path): RouteObject => ({ path, loader: classicLoader })),
      { path: '/workflows', loader: ({ request }) => redirect(keepAll(request, '/b/recipes')) },
      {
        path: '/workflows/:workflowId',
        loader: ({ request, params }) =>
          redirect(keepAll(request, `/b/recipes/${params.workflowId ?? ''}`)),
      },
      { path: '/runs/:briefId', loader: runRedirect },
      // Stored links and notifications from before 11.11 still open the page they meant.
      {
        path: '/now/watch/:agentId',
        loader: ({ request, params }) =>
          redirect(keepSearch(request, `/b/screen/${params.agentId ?? ''}`)),
      },
      {
        path: '/now/flow/workflows',
        loader: ({ request }) => redirect(keepAll(request, '/b/recipes')),
      },
      {
        path: '/now/flow/workflows/:workflowId',
        loader: ({ request, params }) =>
          redirect(keepAll(request, `/b/recipes/${params.workflowId ?? ''}`)),
      },
      {
        path: '/now/flow/:briefId',
        loader: ({ request, params }) => runRedirect({ request, params }),
      },
      {
        path: '/now/routines',
        loader: ({ request }) => redirect(keepSearch(request, '/b/team')),
      },
      { path: '/now/*', loader: ({ request }) => redirect(keepSearch(request, '/b')) },
      { path: '/tasks/*', loader: () => redirect('/b') },
      { path: '/u/*', loader: () => redirect('/b') },
      { path: '/pair', loader: pairBrowser, Component: PairPage },
      { path: '*', loader: () => redirect('/b') },
    ],
  },
]

export function App({ router }: { router: DataRouter }) {
  return <RouterProvider router={router} />
}
