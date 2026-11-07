import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { open, shellState } from './BoldShell-helpers.tsx'
import { fullTopic, plainTopic, runSummary, runTopic } from './BoldShell-run-fixtures.ts'

test('a topic that holds a run shows the run card after its divider, and Show graph opens the Graph tab', async () => {
  shellState.runSummaries = [runSummary]
  shellState.runJobs = [fullTopic(runTopic)]
  open('/b', [runTopic])
  const card = await screen.findByRole('region', { name: 'Run: Review and ship' })
  expect(await within(card).findByText('step 3 of 4')).toBeDefined()
  expect(within(card).getByRole('progressbar', { name: 'Steps done' })).toBeDefined()
  const tabs = screen.getByRole('tablist', { name: 'Panel' })
  expect(within(tabs).getByRole('tab', { name: 'Graph' }).getAttribute('aria-selected')).toBe(
    'false',
  )
  fireEvent.click(within(card).getByRole('button', { name: 'Show graph' }))
  expect(within(tabs).getByRole('tab', { name: 'Graph' }).getAttribute('aria-selected')).toBe(
    'true',
  )
  expect(await screen.findByLabelText('Graph of Review and ship')).toBeDefined()
  expect(
    screen.getByText('Run · Review and ship', { selector: '.bold-topic-graph-head span' }),
  ).toBeDefined()
  // 3.29.0: what only the old run page showed is folded under the log, and the Graph tab has no link to a run page.
  expect(
    within(screen.getByLabelText('Graph of Review and ship')).getByText('Run details'),
  ).toBeDefined()
  expect(
    within(screen.getByLabelText('Graph of Review and ship')).queryByRole('link', {
      name: 'Open the run',
    }),
  ).toBeNull()
  // Back to Info and the graph leaves.
  fireEvent.click(within(tabs).getByRole('tab', { name: 'Info' }))
  expect(screen.queryByLabelText('Graph of Review and ship')).toBeNull()
})

const detailCalls = () =>
  (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((call) => new URL(String(call[0]), 'http://x').pathname)
    .filter((path) => path === '/api/orchestrations/orch-1')

test('a finished run’s card reads the summary only and fetches no run detail', async () => {
  shellState.runSummaries = [
    { ...runSummary, status: 'succeeded', endedAt: '2026-10-24T10:30:00.000Z' },
  ]
  shellState.runJobs = [fullTopic(runTopic)]
  open('/b', [runTopic])
  const card = await screen.findByRole('region', { name: 'Run: Review and ship' })
  expect(await within(card).findByText('2 of 4 steps done')).toBeDefined()
  expect(detailCalls()).toEqual([])
})

test('a run that is still going reads its detail for the who-is-on-what line', async () => {
  shellState.runSummaries = [runSummary]
  shellState.runJobs = [fullTopic(runTopic)]
  open('/b', [runTopic])
  await screen.findByRole('region', { name: 'Run: Review and ship' })
  await waitFor(() => expect(detailCalls().length).toBeGreaterThan(0))
})

test('a run that needs you shows a protected waiting line on its card', async () => {
  shellState.runSummaries = [
    { ...runSummary, needsYou: [{ kind: 'gate', gateId: 'gate-1', stepId: 'step-1' }] },
  ]
  shellState.runJobs = [fullTopic(runTopic)]
  open('/b', [runTopic])
  const card = await screen.findByRole('region', { name: 'Run: Review and ship' })
  const line = (await within(card).findByText(/This run is waiting for you/)).closest(
    '[data-protected]',
  )
  expect(line?.getAttribute('data-protected')).toBe('block')
})

test('moving to a topic without a run resets the panel to Info, so Graph does not come back by itself', async () => {
  shellState.runSummaries = [runSummary]
  shellState.runJobs = [
    fullTopic(runTopic),
    { ...fullTopic(plainTopic as unknown as typeof runTopic), recipe: null },
  ]
  const router = open('/b?job=job-run&work=graph', [runTopic, plainTopic])
  const tabs = screen.getByRole('tablist', { name: 'Panel' })
  await waitFor(() =>
    expect(within(tabs).getByRole('tab', { name: 'Graph' }).getAttribute('aria-selected')).toBe(
      'true',
    ),
  )
  await act(async () => {
    await router.navigate('/b?job=job-plain')
  })
  await waitFor(() => expect(within(tabs).queryByRole('tab', { name: 'Graph' })).toBeNull())
  expect(within(tabs).getByRole('tab', { name: 'Info' }).getAttribute('aria-selected')).toBe('true')
  await act(async () => {
    await router.navigate('/b?job=job-run')
  })
  const graphTab = await within(tabs).findByRole('tab', { name: 'Graph' })
  expect(graphTab.getAttribute('aria-selected')).toBe('false')
  expect(screen.queryByLabelText('Graph of Review and ship')).toBeNull()
})

test('under 1280px the chat list folds to its rail while Graph is open', async () => {
  shellState.narrow = true
  shellState.runSummaries = [runSummary]
  shellState.runJobs = [fullTopic(runTopic)]
  open('/b?job=job-run&work=graph', [runTopic])
  expect(await screen.findByRole('complementary', { name: 'Chats, folded' })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Show the chat list' })).toBeNull()
  const tabs = screen.getByRole('tablist', { name: 'Panel' })
  fireEvent.click(within(tabs).getByRole('tab', { name: 'Info' }))
  expect(await screen.findByRole('complementary', { name: 'Chats' })).toBeDefined()
})

test('from 1280px the chat list stays open beside the Graph tab', async () => {
  shellState.runSummaries = [runSummary]
  shellState.runJobs = [fullTopic(runTopic)]
  open('/b?job=job-run&work=graph', [runTopic])
  expect(await screen.findByLabelText('Graph of Review and ship')).toBeDefined()
  expect(screen.getByRole('complementary', { name: 'Chats' })).toBeDefined()
})

test('on a phone ?work=graph opens the side sheet on its Graph tab', async () => {
  shellState.phone = true
  shellState.runSummaries = [runSummary]
  shellState.runJobs = [fullTopic(runTopic)]
  open('/b?job=job-run&work=graph', [runTopic])
  const panel = await screen.findByRole('complementary', { name: 'Side panel' })
  await waitFor(() => expect(panel.getAttribute('aria-modal')).toBe('true'))
  expect(await within(panel).findByLabelText('Graph of Review and ship')).toBeDefined()
})

test('there is no Graph tab when the current topic holds no run', async () => {
  open('/b', [{ id: 'job-plain', title: 'Plain', state: 'working', isDefault: false }])
  const tabs = screen.getByRole('tablist', { name: 'Panel' })
  expect(within(tabs).queryByRole('tab', { name: 'Graph' })).toBeNull()
})

test('?work=graph opens the Graph tab on the topic’s run', async () => {
  shellState.runSummaries = [runSummary]
  shellState.runJobs = [fullTopic(runTopic)]
  open('/b?job=job-run&work=graph', [runTopic])
  const tabs = screen.getByRole('tablist', { name: 'Panel' })
  await waitFor(() =>
    expect(within(tabs).getByRole('tab', { name: 'Graph' }).getAttribute('aria-selected')).toBe(
      'true',
    ),
  )
  expect(await screen.findByLabelText('Graph of Review and ship')).toBeDefined()
})

test('?run=<id> lands on the chat and topic with the Graph tab open', async () => {
  shellState.runSummaries = [runSummary]
  shellState.runJobs = [fullTopic(runTopic)]
  const router = open('/b?run=orch-1', [runTopic])
  await waitFor(() => expect(router.state.location.search).toContain('work=graph'))
  expect(router.state.location.search).toContain('job=job-run')
  expect(router.state.location.pathname).toBe('/b')
  const tabs = screen.getByRole('tablist', { name: 'Panel' })
  await waitFor(() =>
    expect(within(tabs).getByRole('tab', { name: 'Graph' }).getAttribute('aria-selected')).toBe(
      'true',
    ),
  )
})
