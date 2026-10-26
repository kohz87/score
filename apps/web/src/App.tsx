import { lazy, Suspense, useEffect } from 'react'
import { Outlet, redirect, RouterProvider, useLocation } from 'react-router'
import type { DataRouter, RouteObject } from 'react-router'
import { applyUiParam, readUi } from './bold/bold-ui.ts'
import { BoldTerminalPage } from './bold/BoldTerminal.tsx'
import { boldRedirectFor } from './shell/framed-paths.tsx'
import { BoldClassicPage } from './bold/BoldClassicPage.tsx'
import { BoldHome } from './bold/BoldHome.tsx'
import { BoldShell } from './bold/BoldShell.tsx'
import { BoldAgentPage } from './bold/BoldAgent.tsx'
import { BoldScreenPage } from './bold/BoldScreen.tsx'
import { BoldSettings } from './bold/BoldSettings.tsx'
import { BoldTeam } from './bold/BoldTeam.tsx'
import { PairPage, pairBrowser } from './routes/pair/PairPage.tsx'
import { AgentPage } from './routes/team/AgentPage.tsx'
import { TeamLayout, TeamPage } from './routes/team/TeamPage.tsx'
import { AppShell } from './shell/AppShell.tsx'
import { destinations } from './shell/destinations.ts'
import { SettingsPage } from './routes/settings/SettingsPage.tsx'
import { ChatPage } from './routes/chat/ChatPage.tsx'
import { AttemptPage } from './routes/attempts/AttemptPage.tsx'
import { ReportsPage } from './routes/reports/ReportsPage.tsx'
import { WatchPage } from './routes/watch/WatchPage.tsx'
import { WorkflowEditorRoute } from './routes/workflows/WorkflowEditor.tsx'
import { WorkflowsPage } from './routes/workflows/WorkflowsPage.tsx'

// Knowledge brings CodeMirror and the Markdown renderer: loaded on first visit, not with the shell.
const LazyKnowledgePage = lazy(async () => ({
  default: (await import('./routes/knowledge/KnowledgePage.tsx')).KnowledgePage,
}))
function KnowledgeRoute() {
  return (
    <Suspense fallback={<p role="status">Opening Knowledge…</p>}>
      <LazyKnowledgePage />
    </Suspense>
  )
}

// The terminal brings xterm.js: loaded on first visit.
const LazyTerminalPage = lazy(async () => ({
  default: (await import('./routes/terminal/TerminalPage.tsx')).TerminalPage,
}))
function TerminalRoute() {
  return (
    <Suspense fallback={<p role="status">Opening Terminal…</p>}>
      <LazyTerminalPage />
    </Suspense>
  )
}

function StubPage({ title }: { title: string }) {
  return <h1>{title}</h1>
}

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

/** The new shell's address for an old classic one (decision 123); the classic shell keeps serving its own paths. */
function toBoldLoader({ request }: { request: Request }) {
  if (readUi() !== 'bold') return null
  const url = new URL(request.url)
  const target = boldRedirectFor(url.pathname, url.search, hashOf(url))
  return target ? redirect(target) : null
}

/** A run's old addresses (`/runs/:id`, `/b/runs/:id`, `/now/flow/:id`) open it in the Runs side panel (2.5.0). */
function runRedirect({ request, params }: { request: Request; params: { briefId?: string } }) {
  const url = new URL(request.url)
  const search = new URLSearchParams(url.search)
  search.set('run', params.briefId ?? '')
  return redirect(`/b?${search.toString()}${hashOf(url)}`)
}

const WorkflowsFramed = () => (
  <BoldClassicPage>
    <WorkflowsPage />
  </BoldClassicPage>
)
const WorkflowEditorFramed = () => (
  <BoldClassicPage>
    <WorkflowEditorRoute />
  </BoldClassicPage>
)
const WatchFramed = () => (
  <BoldClassicPage>
    <WatchPage />
  </BoldClassicPage>
)

/** Applies `?ui=bold` / `?ui=classic` from any address to this device's choice; the index loader also applies it first. */
function UiParamBoundary() {
  const location = useLocation()
  useEffect(() => {
    applyUiParam(location.search)
  }, [location.search])
  return <Outlet />
}

export const appRoutes: RouteObject[] = [
  {
    Component: UiParamBoundary,
    children: [
      // 9.4: the theme Customizer is a full-screen editor with no shell around it. It brings CodeMirror and the preview
      // machinery, so it loads on first visit.
      ...['/settings/look/customize', '/settings/look/customize/:themeId'].map(
        (path): RouteObject => ({
          path,
          loader: toBoldLoader,
          lazy: async () => ({
            Component: (await import('./routes/customizer/Customizer.tsx')).Customizer,
          }),
        }),
      ),
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
          { path: 'workflows', Component: WorkflowsFramed },
          { path: 'workflows/:workflowId', Component: WorkflowEditorFramed },
          { path: 'runs/:briefId', loader: runRedirect },
          { path: 'watch/:agentId', Component: WatchFramed },
          { path: 'terminal', Component: BoldTerminalPage },
          ...['settings/look/customize', 'settings/look/customize/:themeId'].map(
            (path): RouteObject => ({
              path,
              lazy: async () => {
                const { Customizer } = await import('./routes/customizer/Customizer.tsx')
                return {
                  Component: () => (
                    <BoldClassicPage variant="customizer">
                      <Customizer />
                    </BoldClassicPage>
                  ),
                }
              },
            }),
          ),
          { path: 'settings', Component: BoldSettings },
          { path: 'settings/:section', Component: BoldSettings },
          { path: '*', loader: () => redirect('/b') },
        ],
      },
      {
        Component: AppShell,
        HydrateFallback: AppShell,
        children: [
          {
            index: true,
            loader: ({ request }) => {
              applyUiParam(new URL(request.url).search)
              return redirect('/b')
            },
          },
          ...destinations.map(({ path, title }): RouteObject => {
            if (path === '/knowledge')
              return {
                path,
                children: [
                  { index: true, Component: KnowledgeRoute },
                  { path: '*', Component: KnowledgeRoute },
                ],
              }
            if (path === '/reports') return { path, Component: ReportsPage }
            // 10.1: one page per section. `/settings` and `/settings#<id>` redirect; an unknown section shows the first one.
            if (path === '/settings')
              return {
                path,
                Component: SettingsPage,
                children: [
                  { index: true, element: <></> },
                  { path: ':section', element: <></> },
                ],
              }
            if (path === '/team')
              return {
                path,
                Component: TeamLayout,
                children: [
                  { index: true, Component: TeamPage },
                  { path: ':agentId', Component: AgentPage },
                  // Deep link into the Workspace tab: /team/:agentId/workspace?path=<file> (workspace:// links in chat).
                  { path: ':agentId/workspace', Component: AgentPage },
                ],
              }
            // Built destinations render their page; the rest stay stubs until their tasks land.
            const page = path === '/chat' ? <ChatPage /> : <StubPage title={title} />
            return {
              path,
              children: [
                { index: true, element: page },
                ...(path === '/chat'
                  ? [':roomId'].map((child) => ({ path: child, element: page }))
                  : []),
              ],
            }
          }),
          // Kept classic pages that used to live under /now. The old paths redirect below.
          {
            path: '/workflows',
            loader: toBoldLoader,
            children: [
              { index: true, Component: WorkflowsPage },
              { path: ':workflowId', Component: WorkflowEditorRoute },
            ],
          },
          { path: '/watch/:agentId', loader: toBoldLoader, Component: WatchPage },
          { path: '/runs/:briefId', loader: runRedirect },
          // Stored links and notifications from before 11.11 still open the page they meant.
          {
            path: '/now/watch/:agentId',
            loader: ({ request, params }) =>
              redirect(keepSearch(request, `/watch/${params.agentId ?? ''}`)),
          },
          {
            path: '/now/flow/workflows',
            loader: ({ request }) => redirect(keepSearch(request, '/workflows')),
          },
          {
            path: '/now/flow/workflows/:workflowId',
            loader: ({ request, params }) =>
              redirect(keepSearch(request, `/workflows/${params.workflowId ?? ''}`)),
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
          { path: '/terminal', loader: toBoldLoader, Component: TerminalRoute },
          { path: '/attempts/:attemptId', Component: AttemptPage },
          { path: '/pair', loader: pairBrowser, Component: PairPage },
          { path: '*', element: <StubPage title="Page not found" /> },
        ],
      },
    ],
  },
]

export function App({ router }: { router: DataRouter }) {
  return <RouterProvider router={router} />
}
