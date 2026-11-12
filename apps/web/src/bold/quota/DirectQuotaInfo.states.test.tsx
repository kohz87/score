import type { StreamEvent } from '@score/contract'
import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { disposeRoomTest, renderInRoom } from '../room/room-test-utils.tsx'
import { DirectQuotaInfo } from './DirectQuotaInfo.tsx'
import { QuotaPill } from './QuotaPill.tsx'
import { stubQuota } from './quota-stub.ts'
import { codingQuota, codingRecord, codingSummaryAgent, NOW } from './quota-test-data.ts'

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})

afterEach(() => {
  disposeRoomTest()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const agent = codingSummaryAgent()
const w = (name: '5 hours' | 'week', used: number | null, resetsAt: string | null = null) => ({
  name,
  group: null,
  usedPercent: used,
  resetsAt,
})

async function section(title = 'Quota · Claude plan') {
  const button = await screen.findByRole('button', { name: new RegExp(title) })
  const element = button.closest('section')!
  await waitFor(() => expect(within(element).queryByText('Reading the quota…')).toBeNull())
  return element
}

test('an unknown share is plain words: "not reported", no meter, for that window only', async () => {
  stubQuota({ quota: codingQuota([w('5 hours', null, '2026-10-16T05:40:00.000Z'), w('week', 20)]) })
  renderInRoom(<DirectQuotaInfo agent={agent} runtime="claude-code" />)
  const el = await section()
  expect(within(el).getByText('not reported')).toBeTruthy()
  expect(within(el).getByText('80% left')).toBeTruthy()
  expect(within(el).getAllByRole('meter')).toHaveLength(1)
  expect(within(el).getByRole('meter', { name: 'Week left' })).toBeTruthy()
})

test('when the floor cannot be read Chat info says so and does not claim the agent is below it', async () => {
  stubQuota({
    quota: codingQuota([w('5 hours', 93, '2026-10-16T05:40:00.000Z')]),
    listStatus: 500,
  })
  renderInRoom(<DirectQuotaInfo agent={agent} runtime="claude-code" />)
  const el = await section()
  await waitFor(() => expect(within(el).getByText(/Its floor couldn’t be read\./)).toBeTruthy())
  expect(el.querySelector('.bold-quota-floor-note')).toBeNull()
  expect(within(el).getByRole('meter', { name: '5 hours left' }).getAttribute('data-tone')).toBe(
    'low',
  )
})

test('the red bar belongs to the window below the floor only', async () => {
  stubQuota({
    quota: codingQuota([
      w('5 hours', 93, '2026-10-16T05:40:00.000Z'),
      w('week', 85, '2026-10-21T05:40:00.000Z'),
    ]),
    record: codingRecord({ quotaFloorPercent: 10 }),
  })
  renderInRoom(<DirectQuotaInfo agent={agent} runtime="claude-code" />)
  const el = await section()
  await waitFor(() => expect(el.querySelector('.bold-quota-floor-note')).toBeTruthy())
  expect(within(el).getByRole('meter', { name: '5 hours left' }).getAttribute('data-tone')).toBe(
    'out',
  )
  expect(within(el).getByRole('meter', { name: 'Week left' }).getAttribute('data-tone')).toBe('low')
})

test('a failed refresh shows the error state in the section and in its folded summary', async () => {
  localStorage.setItem('score.info-fold.quota', 'folded')
  // A floor of 5 keeps 7% left from being a decision, so the section stays folded.
  const stub = stubQuota({
    quota: codingQuota([w('5 hours', 93, '2026-10-16T05:40:00.000Z')]),
    record: codingRecord({ quotaFloorPercent: 5 }),
  })
  // The pill in the footer owns the stream refresh; Chat info reads the same cached query.
  const view = renderInRoom(
    <>
      <QuotaPill agent={agent} runtime="claude-code" onOpen={vi.fn()} />
      <DirectQuotaInfo agent={agent} runtime="claude-code" />
    </>,
  )
  const toggle = await screen.findByRole('button', { name: /Quota · Claude plan/ })
  await waitFor(() => expect(toggle.textContent).toContain('7% 5 h'))

  stub.state.quotaStatus = 500
  act(() =>
    view.emit({
      type: 'run.updated',
      seq: 2,
      ts: '2026-10-16T05:36:00.000Z',
      data: { id: 'r', agentId: 'builder', status: 'failed' },
    } as unknown as StreamEvent),
  )
  await waitFor(() => expect(toggle.textContent).toContain('couldn’t be read'))
  expect(toggle.textContent).not.toContain('7%')
  expect(toggle.closest('section')!.querySelector('.bold-info-needs')).toBeNull()
})

test('Antigravity with no model of its own reads the default group, not a display id', async () => {
  const antigravity = codingSummaryAgent('antigravity', {
    model: { id: 'default', label: 'Default' },
  })
  stubQuota({
    quota: codingQuota(
      [
        { name: '5 hours', group: 'Gemini Models', usedPercent: 12, resetsAt: null },
        {
          name: '5 hours',
          group: 'Claude and GPT models',
          usedPercent: 97,
          resetsAt: '2026-10-16T05:40:00.000Z',
        },
      ],
      { runtime: 'antigravity', source: 'usage' },
    ),
    record: codingRecord({ runtime: 'antigravity', model: null }),
  })
  renderInRoom(<DirectQuotaInfo agent={antigravity} runtime="antigravity" />)
  const el = await section('Quota · Antigravity')
  // The Claude/GPT group is nearly spent, but this agent draws on the Gemini group: no stop notice.
  await waitFor(() => expect(within(el).getByText(/Below 10% \(its floor\)/)).toBeTruthy())
  expect(el.querySelector('.bold-quota-floor-note')).toBeNull()
})

test('a null Antigravity reading is the no-reading sentence', async () => {
  const antigravity = codingSummaryAgent('antigravity')
  stubQuota({ quota: null, record: codingRecord({ runtime: 'antigravity' }) })
  renderInRoom(<DirectQuotaInfo agent={antigravity} runtime="antigravity" />)
  const el = await section('Quota · Antigravity')
  expect(within(el).getByText('Quota · not reported.')).toBeTruthy()
})

test('the stop notice ends when the window resets', async () => {
  vi.useRealTimers()
  vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  stubQuota({ quota: codingQuota([w('5 hours', 93, '2026-10-16T05:40:00.000Z')]) })
  renderInRoom(<DirectQuotaInfo agent={agent} runtime="claude-code" />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50)
  })
  expect(document.querySelector('.bold-quota-floor-note')).toBeTruthy()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 100)
  })
  expect(document.querySelector('.bold-quota-floor-note')).toBeNull()
})
