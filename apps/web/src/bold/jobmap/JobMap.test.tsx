import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { agents, events, fullRun, plainRun } from './job-map-fixtures.ts'
import { JobMapView } from './JobMap.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function media(matching: string[]) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: matching.some((part) => query.includes(part)),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
}

const stop = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null }
// Twenty minutes after s5's last sign of life: stuck.
const now = Date.parse('2026-10-28T10:00:00Z')
const view = (run = fullRun) =>
  render(
    <JobMapView
      run={run}
      events={events}
      agents={agents}
      stop={stop as unknown as Parameters<typeof JobMapView>[0]['stop']}
      now={now}
    />,
  )

test('every layer is a focusable button with its state in the label', () => {
  view()
  for (const name of [
    /^You layer/,
    /^Lead layer: lead, turn 9 of 30, working/,
    /^Advisor layer: reviewer, 1 consult/,
    /^Fork layer/,
    /^Swarm layer: designer, audit, working/,
    /^Workers layer: builder, steps \d+ succeeded/,
    /^Check layer: pnpm test, failed/,
  ])
    expect(screen.getAllByRole('button', { name })[0]).toBeTruthy()
})

test('3.27.0: the Graph tab says "until you stop it" for a run with no turn cap', () => {
  view({ ...fullRun, untilStopped: true } as typeof fullRun)
  expect(
    screen.getAllByRole('button', { name: /^Lead layer: lead, turn 9, until you stop it, / })[0],
  ).toBeTruthy()
  expect(screen.queryByText(/Turn 9 of 30/)).toBeNull()
  expect(screen.getByText(/until you stop it · /)).toBeTruthy()
})

test('a worker that asked its own advisor says so and the stuck step keeps its protected Stop', () => {
  view()
  expect(screen.getByText('asked its advisor 2×')).toBeTruthy()
  const stuck = screen.getByRole('alert')
  expect(stuck.getAttribute('data-protected')).toBe('block')
  expect(within(stuck).getByRole('button', { name: 'Stop this step' })).toBeTruthy()
})

test('clicking a node filters the session log to its layer, again clears it', () => {
  view()
  const log = screen.getByRole('region', { name: 'Session log' })
  expect(within(log).getAllByRole('listitem').length).toBeGreaterThan(5)
  fireEvent.click(screen.getByRole('button', { name: /^Swarm layer: designer/ }))
  expect(within(log).getAllByRole('listitem').length).toBe(1)
  expect(within(log).getByText('designer audits the diff')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Show everything' }))
  expect(within(log).getAllByRole('listitem').length).toBeGreaterThan(5)
  // A worker's own advisor is the worker's, not the job advisor's (3.14.1).
  fireEvent.click(screen.getByRole('button', { name: /^Advisor layer/ }))
  expect(within(log).queryByText('builder asked its advisor')).toBeNull()
  fireEvent.click(screen.getAllByRole('button', { name: /^Workers layer: builder/ })[0]!)
  expect(within(log).getAllByText('builder asked its advisor').length).toBe(2)
})

test('a plain job draws no advisor, swarm, votes or check', () => {
  view(plainRun)
  expect(screen.queryByRole('button', { name: /^Advisor layer/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /^Swarm layer/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /^Fork layer/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /^Check layer/ })).toBeNull()
  expect(screen.getAllByRole('button', { name: /^Workers layer/ }).length).toBeGreaterThan(0)
})

test('the phone gets its own layout, the advisor marks on the lead card', () => {
  media(['width < 600px'])
  const { container } = view()
  expect(container.querySelector('.jobmap--phone')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^Advisor layer/ })).toBeNull()
  const lead = screen.getByRole('button', { name: /^Lead layer/ })
  expect(lead.textContent).toContain('◆ before plan')
  expect(lead.textContent).toContain('1 consult')
})

test('the desktop layout has no phone class and moving dots run along active lines', () => {
  const { container } = view()
  expect(container.querySelector('.jobmap--phone')).toBeNull()
  expect(container.querySelectorAll('.jobmap-dot').length).toBeGreaterThan(0)
})

test('reduced motion draws no moving dots', () => {
  media(['prefers-reduced-motion'])
  const { container } = view()
  expect(container.querySelector('.jobmap--still')).toBeTruthy()
  expect(container.querySelectorAll('.jobmap-dot').length).toBe(0)
})

// 3.27.1 (owner's Troubleshooting note): the map stacks by its own width, so the 420px Graph panel and a narrow sheet
// get the one-column layout instead of a wrapped side-by-side top row.
function boxWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
}

test('a map narrower than its top row stacks; a plain map needs less room than one with an advisor', () => {
  boxWidth(980)
  const advised = view()
  expect(advised.container.querySelector('.jobmap--phone')).toBeTruthy()
  expect(screen.getByRole('button', { name: /^Lead layer/ }).textContent).toContain('1 consult')
  advised.unmount()
  const plain = view(plainRun)
  expect(plain.container.querySelector('.jobmap--phone')).toBeNull()
  plain.unmount()
  boxWidth(420)
  expect(view(plainRun).container.querySelector('.jobmap--phone')).toBeTruthy()
  vi.restoreAllMocks()
})
