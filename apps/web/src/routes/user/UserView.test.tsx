import { readFileSync } from 'node:fs'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  orchestrationEvents,
  orchestrationFixtures,
} from '../../../../../e2e/orchestration-fixtures.ts'
import { workflowFixtures } from '../../../../../e2e/workflow-fixtures.ts'
import { App, appRoutes } from '../../App.tsx'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { lookStore } from '../../themes/look-store.ts'

// PLAN 8.4 in the browser: the user view's room shows a run's progress as Score status lines between the messages,
// answers what needs the person inline, keeps Pause and Stop, and opens the admin view's Flow for the details.

class Source extends EventTarget {
  close() {}
}
// The recorded fake-mode reads the visual baselines are made from: one room, four neutral agents.
const recorded = JSON.parse(readFileSync('../../e2e/fixtures/visual.json', 'utf8')) as Record<
  string,
  unknown
>
const fixtures: Record<string, unknown> = {
  '/api/rooms': recorded['/api/rooms'],
  '/api/agents': recorded['/api/agents'],
  '/api/rooms/room-activity-feed': recorded['/api/rooms/room-activity-feed'],
  '/api/rooms/room-activity-feed/messages?limit=50':
    recorded['/api/rooms/room-activity-feed/messages?limit=50'],
  '/api/rooms/room-activity-feed/versions': { items: [] },
  '/api/commands': { items: [] },
  '/api/workflow-runs': { asOfSeq: 0, items: [] },
  ...orchestrationFixtures,
  '/api/orchestrations/orch-1/events': orchestrationEvents,
}
let posts: { url: string; body: unknown }[]
const disposers: (() => void)[] = []

beforeEach(() => {
  posts = []
  window.localStorage.clear()
  lookStore.reset()
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x')
      url.searchParams.delete('tz')
      const key = `${url.pathname}${url.search}`
      if (init?.method === 'POST') {
        posts.push({ url: key, body: JSON.parse(String(init.body ?? '{}')) })
        return Promise.resolve(
          Response.json(
            fixtures['/api/orchestrations'] &&
              (fixtures['/api/orchestrations'] as { items: unknown[] }).items[0],
          ),
        )
      }
      const fixture = fixtures[key]
      return Promise.resolve(
        fixture === undefined
          ? Response.json({ error: { code: 'not_found', message: 'none' } }, { status: 404 })
          : Response.json(fixture),
      )
    }),
  )
})
afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((fn) => fn())
  vi.unstubAllGlobals()
})

function open(path: string) {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source as never })
  const queries = createStreamQueryRegistry(queryClient, client, immediateFrameScheduler)
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  disposers.push(() => {
    router.dispose()
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <App router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
  return router
}

test('a run’s room shows Score status lines, with no admin links', async () => {
  open('/u/rooms/room-activity-feed')
  const lines = await screen.findAllByText(/Step s1 \(builder\) finished\./)
  expect(lines.length).toBeGreaterThan(0)
  expect(await screen.findByText(/Waiting for you: approve s3\./)).toBeTruthy()
  // Score’s lines carry no agent glyph and no message actions.
  const line = lines[0]!.closest('[data-status-line]') as HTMLElement
  expect(line.querySelector('.agent-glyph')).toBeNull()
  expect(within(line).queryByRole('button')).toBeNull()
  expect(screen.queryByRole('link', { name: 'See it on the Score' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Open the live diagram' })).toBeNull()
})

test('what needs the person is answered in the conversation', async () => {
  open('/u/rooms/room-activity-feed')
  const gate = await screen.findByRole('region', { name: 'Approve s3' })
  fireEvent.click(within(gate).getByRole('button', { name: 'Approve s3' }))
  await waitFor(() =>
    expect(posts.some((post) => post.url === '/api/orchestrations/orch-1/gates/g3/decision')).toBe(
      true,
    ),
  )
  expect(posts.find((post) => post.url.endsWith('/decision'))!.body).toMatchObject({
    decision: 'approve',
    expectedRevision: 1,
    orchestrationRevision: 9,
  })
})

test('Pause is one click and Stop asks first', async () => {
  open('/u/rooms/room-activity-feed')
  const run = await screen.findByRole('region', { name: 'Orchestration' })
  fireEvent.click(await within(run).findByRole('button', { name: 'Pause' }))
  await waitFor(() =>
    expect(posts.some((post) => post.url === '/api/orchestrations/orch-1/pause')).toBe(true),
  )
  fireEvent.click(within(run).getByRole('button', { name: 'Stop' }))
  expect(posts.some((post) => post.url.endsWith('/stop'))).toBe(false)
  fireEvent.click(within(run).getByRole('button', { name: 'Stop the run' }))
  await waitFor(() =>
    expect(posts.some((post) => post.url === '/api/orchestrations/orch-1/stop')).toBe(true),
  )
})

test('See full details opens the run’s Flow in the admin view and remembers it', async () => {
  const router = open('/u/rooms/room-activity-feed')
  fireEvent.click(await screen.findByRole('button', { name: 'See full details' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/now/flow/brief-orch-1'))
  expect(window.localStorage.getItem('score.view')).toBeNull()
})

test('/ opens the user view in a browser that was left there', async () => {
  window.localStorage.setItem('score.view', 'user')
  const router = open('/')
  await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/u/))
})

test('a workflow room shows the compact header, not the admin panel, and details switch views', async () => {
  Object.assign(fixtures, workflowFixtures, {
    '/api/orchestrations': { asOfSeq: 0, items: [] },
  })
  const router = open('/u/rooms/room-activity-feed')
  const header = await screen.findByRole('region', { name: 'Workflow' })
  expect(within(header).getByText('Release notes: the 2.4 release')).toBeTruthy()
  expect(within(header).getByText('2 of 7 steps done')).toBeTruthy()
  expect(await within(header).findByRole('button', { name: 'Pause' })).toBeTruthy()
  // The admin panel and its link to the live diagram are not part of this view.
  expect(screen.queryByRole('region', { name: 'Workflow run' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Open the live diagram' })).toBeNull()
  // What needs the person is still answerable in the conversation.
  expect(await screen.findByRole('region', { name: /approve/i })).toBeTruthy()
  fireEvent.click(within(header).getByRole('button', { name: 'See full details' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/now/flow/brief-wfrun-1'))
})

// Phase 9 re-gate #8: the chat-first view has the same protected way back as the admin view. It sits on the page while
// a theme from outside Score is on (the sidebar and its avatar menu are what a theme can rearrange).
const themeSummary = (id: string, source: string) => ({
  id,
  name: id,
  version: '1.0.0',
  author: null,
  description: null,
  source,
  updatedAt: '2026-10-17T00:00:00.000Z',
  hasCss: true,
})
function wear(id: string, source: 'builtin' | 'imported') {
  fixtures['/api/themes'] = {
    items: [themeSummary('score', 'builtin'), themeSummary(id, source)],
    active: id,
    mode: 'system',
  }
  window.localStorage.setItem('score.look.device', id)
  lookStore.reset()
}
const wearOutsideTheme = () => wear('gate', 'imported')
afterEach(() => {
  delete fixtures['/api/themes']
})

test('Score’s own looks and the default need no way-back bar', async () => {
  wear('harbour', 'builtin')
  open('/u/rooms/room-activity-feed')
  await screen.findByRole('link', { name: 'New chat' })
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(screen.queryByRole('navigation', { name: 'Way back' })).toBeNull()
})

// Cross-audit X15: the way back must not wait for the theme list. A slow or failed list leaves the boot cache's custom
// look on the page, and the bar's own CSS gates its display.
test('the way back is on the page while the theme list has not arrived (or failed)', async () => {
  // No /api/themes fixture: the list answers 404.
  window.localStorage.setItem('score.look.device', 'gate')
  lookStore.reset()
  open('/u/rooms/room-activity-feed')
  const way = await screen.findByRole('navigation', { name: 'Way back' })
  expect(way.getAttribute('data-protected')).toBe('flex')
})

test('the way back (palette, admin view, settings, reset look) is on the user view and protected', async () => {
  wearOutsideTheme()
  open('/u/rooms/room-activity-feed')
  const way = await screen.findByRole('navigation', { name: 'Way back' })
  expect(way.getAttribute('data-protected')).toBe('flex')
  for (const name of ['Search or run a command', 'Admin view', 'Settings', 'Reset look'])
    expect(within(way).getByRole('button', { name })).toBeTruthy()
  // The conversations opener and the avatar are protected too, so a theme that hides them is switched off.
  expect(document.querySelector('.user-menu-button')!.getAttribute('data-protected')).not.toBeNull()
  expect(document.querySelector('.avatar')!.getAttribute('data-protected')).not.toBeNull()
})

test('Ctrl+K opens the palette on the user view; Settings goes through the view switch', async () => {
  wearOutsideTheme()
  const router = open('/u/rooms/room-activity-feed')
  await screen.findByRole('navigation', { name: 'Way back' })
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
  const palette = await screen.findByRole('dialog', { name: 'Search or run a command' })
  // No admin destinations of its own: the way back only.
  expect(within(palette).queryByRole('link')).toBeNull()
  fireEvent.change(within(palette).getByRole('searchbox'), { target: { value: 'sett' } })
  fireEvent.click(within(palette).getByRole('button', { name: 'Settings' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
  expect(window.localStorage.getItem('score.view')).toBeNull()
})

test('with the admin password guard on, the way back asks for the password first', async () => {
  wearOutsideTheme()
  window.localStorage.setItem('score.view.guard', '1')
  const router = open('/u/rooms/room-activity-feed')
  const way = await screen.findByRole('navigation', { name: 'Way back' })
  fireEvent.click(within(way).getByRole('button', { name: 'Settings' }))
  await screen.findByLabelText('Security password')
  expect(router.state.location.pathname).toBe('/u/rooms/room-activity-feed')
})

test('Reset look in the way back clears this device’s look', async () => {
  wearOutsideTheme()
  open('/u/rooms/room-activity-feed')
  const way = await screen.findByRole('navigation', { name: 'Way back' })
  fireEvent.click(within(way).getByRole('button', { name: 'Reset look' }))
  expect(window.localStorage.getItem('score.look.device')).toBe('score')
})
