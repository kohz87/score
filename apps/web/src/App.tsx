import { redirect, RouterProvider } from 'react-router'
import type { DataRouter, RouteObject } from 'react-router'
import { PairPage, pairBrowser } from './routes/pair/PairPage.tsx'
import { AgentPage } from './routes/team/AgentPage.tsx'
import { TeamLayout, TeamPage } from './routes/team/TeamPage.tsx'
import { AppShell } from './shell/AppShell.tsx'
import { destinations } from './shell/destinations.ts'

function StubPage({ title }: { title: string }) {
  return <h1>{title}</h1>
}

export const appRoutes: RouteObject[] = [
  {
    Component: AppShell,
    HydrateFallback: AppShell,
    children: [
      { index: true, loader: () => redirect('/now') },
      {
        path: '/team',
        Component: TeamLayout,
        children: [
          { index: true, Component: TeamPage },
          { path: ':agentId', Component: AgentPage },
        ],
      },
      ...destinations
        .filter(({ path }) => path !== '/team')
        .map(({ path, title }) => ({
          path,
          children: [
            { index: true, element: <StubPage title={title} /> },
            ...(path === '/now'
              ? ['flow', 'routines', 'watch/:agentId']
              : path === '/chat'
                ? [':roomId']
                : []
            ).map((child) => ({ path: child, element: <StubPage title={title} /> })),
          ],
        })),
      { path: '/pair', loader: pairBrowser, Component: PairPage },
      { path: '*', element: <StubPage title="Page not found" /> },
    ],
  },
]

export function App({ router }: { router: DataRouter }) {
  return <RouterProvider router={router} />
}
