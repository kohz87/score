import { QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary, LaneBlock, NowSnapshot } from '@score/contract'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { NowPage } from './NowPage.tsx'

configure({ asyncUtilTimeout: 5000 })

class Source extends EventTarget {
  close() {}
}

const builder: AgentSummary = {
  id: 'builder',
  name: 'builder',
  role: 'builder role',
  style: { color: '#19C39A', shape: 'triangle' },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
}
const now = '2026-10-08T21:31:00.000Z'
const at = (minutes: number) => new Date(Date.parse(now) + minutes * 60_000).toISOString()

const attemptBlock = (over: Partial<LaneBlock> & { id: string }): LaneBlock => ({
  label: 'Attempt',
  state: 'done',
  start: at(-40),
  end: at(-30),
  taskId: 't1',
  runId: null,
  kind: 'task',
  provenance: 'proven',
  ...over,
})

function snapshot(overrides: Partial<NowSnapshot> = {}): NowSnapshot {
  return {
    asOfSeq: 1,
    now,
    paused: false,
    headline: { working: 0, needsYou: 0, text: 'Quiet.' },
    lanes: [{ agent: builder, blocks: [] }],
    handoffs: [],
    focusApproval: null,
    thread: null,
    madeToday: [],
    ...overrides,
  }
}

let current: NowSnapshot
beforeEach(() => {
  current = snapshot()
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const body =
        url === '/api/now'
          ? current
          : url === '/api/rooms'
            ? { asOfSeq: 1, rooms: [], directs: [] }
            : { items: [] }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
    }),
  )
})
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanup()
  cleanups.splice(0).forEach((fn) => fn())
  vi.unstubAllGlobals()
})

function Where() {
  return <output aria-label="location">{useLocation().pathname}</output>
}
function renderNow() {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client)
  cleanups.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <>
            <NowPage />
            <Where />
          </>
        ),
      },
    ],
    { initialEntries: ['/now'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <RouterProvider router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
}

test('draws an Unattributed lane under the agents with a neutral glyph and no Watch link', async () => {
  current = snapshot({
    unattributed: {
      blocks: [attemptBlock({ id: 'attempt:kr_a', label: 'Mystery job', attemptId: 'kr_a' })],
    },
  })
  renderNow()
  const timeline = await screen.findByRole('region', { name: /^Score:/ })
  const lane = within(timeline).getByRole('group', { name: 'Unattributed, No known agent' })
  expect(within(lane).getByRole('button', { name: /Unattributed: Mystery job, done/ })).toBeTruthy()
  expect(within(timeline).getByRole('img', { name: 'Unknown agent' })).toBeTruthy()
  expect(within(timeline).getByText('Unattributed').closest('a')).toBeNull()
  const groups = within(timeline).getAllByRole('group')
  expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
    'builder, builder role',
    'Unattributed, No known agent',
  ])
})

test('an attempt that stopped being observed has a text alternative and no state word', async () => {
  current = snapshot({
    lanes: [
      {
        agent: builder,
        blocks: [
          attemptBlock({
            id: 'attempt:kr_b',
            label: 'Lost track',
            state: 'working',
            end: null,
            observationEndedAt: at(-20),
            attemptId: 'kr_b',
          }),
        ],
      },
    ],
  })
  renderNow()
  const block = await screen.findByRole('button', { name: /builder: Lost track/ })
  expect(block.getAttribute('aria-label')).toMatch(/no longer observed since 21:11/)
  expect(block.getAttribute('aria-label')).not.toMatch(/working now/)
  expect(block.className).toContain('now-block--unobserved')
  expect(screen.getByText('No longer observed')).toBeTruthy()
})

test('partial provenance says so, and blocks sort by order, not by id', async () => {
  current = snapshot({
    lanes: [
      {
        agent: builder,
        blocks: [
          attemptBlock({
            id: 'attempt:kr_z',
            label: 'Second',
            start: at(-20),
            end: at(-10),
            order: [at(-20), 2],
            provenance: 'partial',
          }),
          attemptBlock({
            id: 'attempt:kr_a',
            label: 'First',
            start: at(-50),
            end: at(-40),
            order: [at(-50), 1],
          }),
        ],
      },
    ],
  })
  renderNow()
  const buttons = await screen.findAllByRole('button', { name: /^builder: (First|Second)/ })
  expect(buttons.map((button) => button.textContent)).toEqual(['First', 'Second'])
  expect(buttons[1]!.getAttribute('aria-label')).toMatch(/provenance unknown/)
  expect(buttons[1]!.getAttribute('title')).toMatch(/provenance unknown/)
})

test('a hand-off to the Unattributed lane is listed', async () => {
  current = snapshot({
    lanes: [
      {
        agent: builder,
        blocks: [attemptBlock({ id: 'attempt:kr_1', label: 'Mine', end: at(-30) })],
      },
    ],
    unattributed: {
      blocks: [attemptBlock({ id: 'attempt:kr_2', label: 'Theirs', start: at(-25), end: at(-10) })],
    },
    handoffs: [
      {
        id: 'h1',
        from: { agentId: 'builder', blockId: 'attempt:kr_1' },
        to: { agentId: null, blockId: 'attempt:kr_2' },
        kind: 'handoff',
        at: at(-25),
      },
    ],
  })
  renderNow()
  expect(await screen.findByText('Hand-off: builder (Mine) to Unattributed (Theirs)')).toBeTruthy()
})

test('a block of an earlier copy of the board opens its attempt page', async () => {
  current = snapshot({
    lanes: [
      {
        agent: builder,
        blocks: [
          attemptBlock({
            id: 'attempt:kr_old',
            label: 'Old board',
            taskId: null,
            attemptId: 'kr_old',
          }),
        ],
      },
    ],
  })
  renderNow()
  fireEvent.click(await screen.findByRole('button', { name: /builder: Old board/ }))
  await waitFor(() =>
    expect(screen.getByLabelText('location').textContent).toBe('/attempts/kr_old'),
  )
})

test('checks read passed, changes requested or not verified, and unknown is not red', async () => {
  current = snapshot({
    madeToday: [
      {
        title: 'Thing',
        ref: { kind: 'task', taskId: 't1' },
        files: [],
        checks: [
          { label: 'A', agentId: 'builder', verdict: 'passed' },
          { label: 'B', agentId: 'builder', verdict: 'changes_requested' },
          { label: 'C', agentId: 'builder', verdict: 'unknown' },
        ],
      },
    ],
  })
  renderNow()
  expect(await screen.findByText(/not verified/)).toBeTruthy()
  expect(screen.getByText(/changes requested/)).toBeTruthy()
  expect(screen.getByText(/passed/)).toBeTruthy()
  const unknownRow = screen.getByText(/not verified/).closest('.now-made-row')!
  expect(unknownRow.innerHTML).not.toContain('#B01E43')
})
