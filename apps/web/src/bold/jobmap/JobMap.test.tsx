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
    /^Advisor layer: reviewer, on call to the workers/,
    /^Fork layer/,
    /^Swarm layer: designer, audit, working/,
    /^Workers layer: builder, steps \d+ succeeded/,
    /^Check layer: pnpm test, failed/,
  ])
    expect(screen.getAllByRole('button', { name })[0]).toBeTruthy()
})

test('a worker that asked the advisor says so and the stuck step keeps its protected Stop', () => {
  view()
  expect(screen.getByText('asked the advisor 2× (18k tokens)')).toBeTruthy()
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
  fireEvent.click(screen.getByRole('button', { name: /^Advisor layer/ }))
  expect(within(log).getByText('builder asked the advisor: which file?')).toBeTruthy()
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
  expect(lead.textContent).toContain('3 consults')
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

function stubLayout() {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const box = (left: number, top: number, w: number, h: number) =>
      ({
        left,
        top,
        right: left + w,
        bottom: top + h,
        width: w,
        height: h,
        x: left,
        y: top,
      }) as DOMRect
    if (this.getAttribute('data-anchor') === 'advisor') return box(500, 10, 200, 60)
    if (this.getAttribute('data-anchor')?.startsWith('worker:')) return box(50, 300, 300, 80)
    return box(0, 0, 800, 600)
  })
}

test('a worker that asked the advisor gets a dashed path back to the advisor, labelled', () => {
  stubLayout()
  const { container } = view()
  const paths = container.querySelectorAll('.jobmap-links .jobmap-link')
  expect(paths.length).toBe(1)
  expect(paths[0]?.hasAttribute('data-live')).toBe(false)
  expect(container.querySelector('.jobmap-links')?.getAttribute('aria-hidden')).toBe('true')
  expect(
    within(container.querySelector('.jobmap-links') as unknown as HTMLElement).getByText(
      'asked 2× · 18k tokens',
    ),
  ).toBeTruthy()
  expect(container.querySelector('.jobmap-link-dot')).toBeNull()
})

test('no path without on-call consults', () => {
  stubLayout()
  const { container } = view(plainRun)
  expect(container.querySelector('.jobmap-links')).toBeNull()
})

test('a running consult makes the path live with a moving dot and the question', () => {
  stubLayout()
  const run = structuredClone(fullRun)
  const last = run.advisor!.onCall!.at(-1)!
  last.status = 'running'
  const { container } = view(run)
  expect(container.querySelector('.jobmap-link')?.hasAttribute('data-live')).toBe(true)
  expect(container.querySelector('.jobmap-link-dot')).toBeTruthy()
  expect(screen.getByText('builder is asking the advisor… (2nd time)')).toBeTruthy()
  expect(screen.getByText('retry how?', { selector: 'text' })).toBeTruthy()
})

test('reduced motion keeps the live path but drops the moving dot', () => {
  stubLayout()
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('reduce'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  const run = structuredClone(fullRun)
  run.advisor!.onCall!.at(-1)!.status = 'running'
  const { container } = view(run)
  expect(container.querySelector('.jobmap-link')?.hasAttribute('data-live')).toBe(true)
  expect(container.querySelector('.jobmap-link-dot')).toBeNull()
})
