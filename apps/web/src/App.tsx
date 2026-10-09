import { lazy, Suspense } from 'react'
import { redirect, RouterProvider } from 'react-router'
import type { DataRouter, RouteObject } from 'react-router'
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
import { ReportsPage } from './routes/reports/ReportsPage.tsx'

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

function StubPage({ title }: { title: string }) {
  return <h1>{title}</h1>
}

export const appRoutes: RouteObject[] = [
  {
    Component: AppShell,
    HydrateFallback: AppShell,
    children: [
      { index: true, loader: () => redirect('/now') },
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
        if (path === '/settings') return { path, Component: SettingsPage }
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
              ? ['routines', 'flow', 'flow/:briefId', 'watch/:agentId']
              : path === '/chat'
                ? [':roomId']
                : []
            ).map((child) => ({ path: child, element: page })),
          ],
        }
      }),
      { path: '/attempts/:attemptId', Component: AttemptPage },
      { path: '/pair', loader: pairBrowser, Component: PairPage },
      { path: '*', element: <StubPage title="Page not found" /> },
    ],
  },
]

export function App({ router }: { router: DataRouter }) {
  return <RouterProvider router={router} />
}
