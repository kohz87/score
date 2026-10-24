import { lazy, Suspense, useEffect } from 'react'
import { Outlet, redirect, RouterProvider, useLocation } from 'react-router'
import type { DataRouter, RouteObject } from 'react-router'
import { applyUiParam, readUi } from './bold/bold-ui.ts'
import { BoldRoom } from './bold/BoldRoom.tsx'
import { BoldShell } from './bold/BoldShell.tsx'
import { BoldSettings, BoldTeam } from './bold/BoldPlaceholder.tsx'
import { PairPage, pairBrowser } from './routes/pair/PairPage.tsx'
import { AgentPage } from './routes/team/AgentPage.tsx'
import { TeamLayout, TeamPage } from './routes/team/TeamPage.tsx'
import { TasksPage } from './routes/tasks/TasksPage.tsx'
import { AppShell } from './shell/AppShell.tsx'
import { destinations } from './shell/destinations.ts'
import { SettingsPage } from './routes/settings/SettingsPage.tsx'
import { ChatPage } from './routes/chat/ChatPage.tsx'
import { NowPage } from './routes/now/NowPage.tsx'
import { AttemptPage } from './routes/attempts/AttemptPage.tsx'
import { PopOutPage } from './routes/pop/PopOutPage.tsx'
import { ReportsPage } from './routes/reports/ReportsPage.tsx'
import { UserHome } from './routes/user/UserHome.tsx'
import { UserRoom } from './routes/user/UserRoom.tsx'
import { UserShell } from './routes/user/UserShell.tsx'
import { readView } from './routes/user/user-view.ts'

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
      // 7.4b: one agent's compact view for its own browser window; no shell around it.
      { path: '/agents/:agentId/pop', Component: PopOutPage },
      // 9.4: the theme Customizer is a full-screen editor with no shell around it. It brings CodeMirror and the preview
      // machinery, so it loads on first visit.
      ...['/settings/look/customize', '/settings/look/customize/:themeId'].map(
        (path): RouteObject => ({
          path,
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
          { index: true, Component: BoldRoom },
          { path: 'team', Component: BoldTeam },
          { path: 'settings', Component: BoldSettings },
          { path: '*', loader: () => redirect('/b') },
        ],
      },
      // 8.4: the chat-first user view has its own shell; the admin view's routes stay as they were.
      {
        path: '/u',
        Component: UserShell,
        HydrateFallback: UserShell,
        children: [
          { index: true, Component: UserHome },
          { path: 'rooms/:roomId', Component: UserRoom },
          { path: '*', loader: () => redirect('/u') },
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
              return redirect(readUi() === 'bold' ? '/b' : readView() === 'user' ? '/u' : '/now')
            },
          },
          ...destinations.map(({ path, title }): RouteObject => {
            if (path === '/tasks')
              return {
                path,
                Component: TasksPage,
                children: [
                  { index: true, element: <></> },
                  { path: ':taskId', element: <></> },
                ],
              }
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
            const page =
              path === '/chat' ? (
                <ChatPage />
              ) : path === '/now' ? (
                <NowPage />
              ) : (
                <StubPage title={title} />
              )
            return {
              path,
              children: [
                { index: true, element: page },
                ...(path === '/now'
                  ? [
                      'routines',
                      'flow',
                      'flow/workflows',
                      'flow/workflows/:workflowId',
                      'flow/:briefId',
                      'watch/:agentId',
                    ]
                  : path === '/chat'
                    ? [':roomId']
                    : []
                ).map((child) => ({ path: child, element: page })),
              ],
            }
          }),
          { path: '/terminal', Component: TerminalRoute },
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
