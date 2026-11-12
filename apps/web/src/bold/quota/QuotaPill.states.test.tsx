import type { StreamEvent } from '@score/contract'
import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { disposeRoomTest, renderInRoom } from '../room/room-test-utils.tsx'
import { QuotaPill } from './QuotaPill.tsx'
import { codingQuota, codingRecord, codingSummaryAgent, NOW } from './quota-test-data.ts'
import { stubQuota } from './quota-stub.ts'

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})

afterEach(() => {
  disposeRoomTest()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const agent = codingSummaryAgent()
const render = (runtime: 'claude-code' | 'antigravity' = 'claude-code') =>
  renderInRoom(<QuotaPill agent={agent} runtime={runtime} onOpen={vi.fn()} />)
async function pill() {
  const button = await screen.findByRole('button', { name: /quota/ })
  await waitFor(() => expect(button.textContent).not.toContain('reading'))
  return button
}
const w = (name: '5 hours' | 'week', used: number | null, resetsAt: string | null = null) => ({
  name,
  group: null,
  usedPercent: used,
  resetsAt,
})

test('an unknown share says "not reported" for that window only; the primary window is the first known one', async () => {
  stubQuota({ quota: codingQuota([w('5 hours', null), w('week', 20)]) })
  render()
  const el = await pill()
  expect(el.textContent).toContain('80% left')
  expect(el.textContent).toContain('week')
  expect(el.getAttribute('aria-label')).toBe(
    'Claude plan quota: 80% left this week, read after the 5:05 am turn',
  )

  disposeRoomTest()
  stubQuota({ quota: codingQuota([w('5 hours', 38), w('week', null)]) })
  render()
  const other = await pill()
  expect(other.textContent).toContain('62% left')
  expect(other.textContent).toContain('not reported')
  expect(other.querySelectorAll('.bold-quota-track')).toHaveLength(1)
  expect(other.getAttribute('aria-label')).toContain('not reported this week')
})

test('every share unknown is words, never a bar', async () => {
  stubQuota({ quota: codingQuota([w('5 hours', null), w('week', null)]) })
  render()
  const el = await screen.findByRole('button', { name: 'Claude plan quota, not reported' })
  expect(el.textContent).toBe('Quota · not reported')
  expect(el.querySelector('.bold-quota-track')).toBeNull()
})

test('the tone follows the unrounded share, and red needs a window below the floor that still has a reset ahead', async () => {
  // 25.4% left is written "25%" and is not amber.
  stubQuota({ quota: codingQuota([w('5 hours', 74.6, '2026-10-16T06:00:00.000Z')]) })
  render()
  const el = await pill()
  expect(el.textContent).toContain('25% left')
  expect(el.getAttribute('data-tone')).toBe('ok')

  disposeRoomTest()
  // 7% left under a floor of 10, but the window's reset time has passed: amber at most, no warning.
  stubQuota({ quota: codingQuota([w('5 hours', 93, '2026-10-16T05:00:00.000Z')]) })
  render()
  const old = await pill()
  expect(old.getAttribute('data-tone')).toBe('low')
  expect(old.hasAttribute('data-protected')).toBe(false)
  expect(old.textContent).not.toContain('below')
})

test('when the floor cannot be read the pill does not claim to be below it', async () => {
  stubQuota({
    quota: codingQuota([w('5 hours', 93, '2026-10-16T05:40:00.000Z')]),
    listStatus: 500,
  })
  render()
  const el = await pill()
  await waitFor(() => expect(el.getAttribute('data-tone')).toBe('low'))
  expect(el.hasAttribute('data-protected')).toBe(false)
  expect(el.textContent).toContain('7% left')
  expect(el.textContent).not.toContain('floor')
})

test('Antigravity shows its own model group in the footer, named once; the default group when the agent has no model', async () => {
  const quota = codingQuota(
    [
      { name: '5 hours', group: 'Gemini Models', usedPercent: 12, resetsAt: null },
      { name: 'week', group: 'Gemini Models', usedPercent: 40, resetsAt: null },
      { name: '5 hours', group: 'Claude and GPT models', usedPercent: 46, resetsAt: null },
    ],
    { runtime: 'antigravity' },
  )
  // The summary's display id is "default"-like; the coding record's model is null: Score's default group.
  stubQuota({ quota, record: codingRecord({ runtime: 'antigravity', model: null }) })
  render('antigravity')
  const el = await pill()
  expect(el.textContent).toContain('Gemini Models')
  expect(el.textContent).toContain('88%')
  expect(el.textContent).toContain('60%')
  expect(el.textContent).not.toContain('54%')
  expect(el.getAttribute('aria-label')).toContain('Gemini Models: 88% left in 5 hours')
})

test('a null Antigravity reading is the no-reading state, not "reading…"', async () => {
  stubQuota({ quota: null, record: codingRecord({ runtime: 'antigravity', model: null }) })
  render('antigravity')
  const el = await screen.findByRole('button', { name: 'Antigravity quota, not reported' })
  expect(el.textContent).toBe('Quota · not reported')
})

test('a failed refresh replaces the old reading and its warning with the error state', async () => {
  const stub = stubQuota({ quota: codingQuota([w('5 hours', 93, '2026-10-16T05:40:00.000Z')]) })
  const view = render()
  await screen.findByRole('button', { name: /below its 10% floor/ })

  stub.state.quotaStatus = 500
  act(() =>
    view.emit({
      type: 'run.updated',
      seq: 2,
      ts: '2026-10-16T05:36:00.000Z',
      data: { id: 'r', agentId: 'builder', status: 'completed' },
    } as unknown as StreamEvent),
  )
  const error = await screen.findByRole('button', { name: 'Claude plan quota, couldn’t be read' })
  expect(error.textContent).toBe('Quota · couldn’t be read')
  expect(error.hasAttribute('data-protected')).toBe(false)
  expect(error.querySelector('.bold-quota-track')).toBeNull()
})

test('the warning ends when the window resets, without a reload', async () => {
  vi.useRealTimers()
  vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  stubQuota({ quota: codingQuota([w('5 hours', 93, '2026-10-16T05:40:00.000Z')]) })
  render()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50)
  })
  const el = screen.getByRole('button', { name: /below its 10% floor/ })
  expect(el.hasAttribute('data-protected')).toBe(true)

  // Five minutes later the window has reset: the same pill, now amber, no warning.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 100)
  })
  expect(screen.queryByRole('button', { name: /below its 10% floor/ })).toBeNull()
  const after = screen.getByRole('button', { name: /Claude plan quota/ })
  expect(after.hasAttribute('data-protected')).toBe(false)
})

test('the reading is fetched at most once a minute while the chat is open', async () => {
  vi.useRealTimers()
  vi.useFakeTimers({
    now: NOW,
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  })
  const stub = stubQuota({ quota: codingQuota() })
  render()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50)
  })
  expect(stub.calls('coding-agents/builder/quota')).toBe(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(55_000)
  })
  expect(stub.calls('coding-agents/builder/quota')).toBe(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6_000)
  })
  expect(stub.calls('coding-agents/builder/quota')).toBe(2)
})
