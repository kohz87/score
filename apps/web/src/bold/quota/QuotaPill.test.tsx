import type { StreamEvent } from '@score/contract'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { disposeRoomTest, jsonResponse, mockFetch, renderInRoom } from '../room/room-test-utils.tsx'
import { QuotaPill } from './QuotaPill.tsx'
import { codingQuota, codingRecord, codingSummaryAgent, NOW } from './quota-test-data.ts'

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})

afterEach(() => {
  disposeRoomTest()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const agent = codingSummaryAgent()

function stub(
  quota: ReturnType<typeof codingQuota> | null,
  record = codingRecord(),
  quotaStatus = 200,
) {
  const fetchMock = mockFetch((url) => {
    if (url === '/api/coding-agents/builder/quota')
      return quotaStatus === 200
        ? jsonResponse({ quota })
        : jsonResponse({ error: { code: 'unreadable', message: 'No reading.' } }, quotaStatus)
    if (url === '/api/coding-agents') return jsonResponse({ items: [record] })
    return jsonResponse({}, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderPill(onOpen = vi.fn()) {
  return renderInRoom(<QuotaPill agent={agent} runtime="claude-code" onOpen={onOpen} />)
}

test('the pill shows the 5-hour bar and every window’s own share, and opens Chat info', async () => {
  const onOpen = vi.fn()
  stub(codingQuota())
  renderPill(onOpen)

  const pill = await screen.findByRole('button', {
    name: 'Claude plan quota: 62% left in 5 hours, 80% left this week, read after the 5:05 am turn',
  })
  expect(pill.textContent).toContain('Quota')
  expect(pill.textContent).toContain('62% left')
  expect(pill.textContent).toContain('5 h')
  expect(pill.textContent).toContain('80%')
  expect(pill.textContent).toContain('week')
  expect(pill.querySelector<HTMLElement>('.bold-quota-fill')?.style.width).toBe('62%')
  expect(pill.hasAttribute('data-protected')).toBe(false)

  fireEvent.click(pill)
  expect(onOpen).toHaveBeenCalledOnce()
})

test('under 25% left the bar turns amber and the reset time joins the pill', async () => {
  stub(
    codingQuota([
      { name: '5 hours', group: null, usedPercent: 82, resetsAt: '2026-10-16T05:40:00.000Z' },
      { name: 'week', group: null, usedPercent: 20, resetsAt: '2026-10-21T05:40:00.000Z' },
    ]),
  )
  renderPill()

  const pill = await screen.findByRole('button', { name: /Claude plan quota: .* read after/ })
  expect(pill.getAttribute('data-tone')).toBe('low')
  expect(pill.textContent).toContain('18% left')
  expect(pill.textContent).toContain('5 h')
  expect(pill.textContent).toContain('resets 5:40 am')
  expect(pill.querySelector('.bold-quota-fill')?.getAttribute('data-tone')).toBeNull()
  expect(pill.querySelector<HTMLElement>('.bold-quota-track')?.getAttribute('data-tone')).toBe(
    'low',
  )
})

test('below its floor the pill becomes the light protected warning with no plan label', async () => {
  stub(
    codingQuota([
      { name: '5 hours', group: null, usedPercent: 93, resetsAt: '2026-10-16T05:40:00.000Z' },
      { name: 'week', group: null, usedPercent: 20, resetsAt: '2026-10-21T05:40:00.000Z' },
    ]),
  )
  renderPill()

  const pill = await screen.findByRole('button', {
    name: 'Claude plan quota: 7% left, below its 10% floor',
  })
  expect(pill.className).toContain('bold-quota-floor')
  expect(pill.getAttribute('data-protected')).toBe('inline-flex')
  expect(pill.textContent).toContain('7% left · below its 10% floor')
  expect(pill.textContent).not.toContain('Quota')
  expect(pill.querySelector<HTMLElement>('.bold-quota-fill')?.style.width).toBe('7%')
})

test('no reading yet and a failed read are words, never a bar', async () => {
  stub(null)
  const view = renderPill()
  const none = await screen.findByRole('button', {
    name: 'Claude plan quota, shows after its first turn',
  })
  expect(none.textContent).toBe('Quota · shows after its first turn')
  expect(none.querySelector('.bold-quota-track')).toBeNull()
  view.unmount()

  stub(null, codingRecord(), 500)
  renderPill()
  const error = await screen.findByRole('button', {
    name: 'Claude plan quota, couldn’t be read',
  })
  expect(error.textContent).toBe('Quota · couldn’t be read')
  expect(error.querySelector('.bold-quota-track')).toBeNull()
})

const runEvent = (agentId: string, status: string, seq = 2) =>
  ({
    type: 'run.updated',
    seq,
    ts: '2026-10-16T05:36:00.000Z',
    data: {
      id: 'run-1',
      agentId,
      origin: 'score',
      status,
      startedAt: '2026-10-16T05:30:00.000Z',
      endedAt: null,
      model: null,
      toolsUsed: [],
      tokens: null,
      costUsd: null,
      refs: [],
      gaps: [],
    },
  }) as unknown as StreamEvent

test('a run of this agent ending, in any room, refreshes the quota; a message or another agent does not', async () => {
  const fetchMock = stub(codingQuota())
  const view = renderPill()
  await screen.findByRole('button', { name: /Claude plan quota: .* read after/ })
  const quotaCalls = () =>
    fetchMock.mock.calls.filter(([url]) => String(url) === '/api/coding-agents/builder/quota')
  expect(quotaCalls()).toHaveLength(1)

  act(() =>
    view.emit({
      type: 'message.completed',
      seq: 2,
      ts: '2026-10-16T05:36:00.000Z',
      data: { messageId: 'message-1', roomId: 'room-1' },
    } as StreamEvent),
  )
  act(() => view.emit(runEvent('builder', 'running', 3)))
  act(() => view.emit(runEvent('other', 'completed', 4)))
  await act(async () => {
    await Promise.resolve()
  })
  expect(quotaCalls()).toHaveLength(1)

  act(() => view.emit(runEvent('builder', 'completed', 5)))
  await waitFor(() => expect(quotaCalls()).toHaveLength(2))
  act(() => view.emit(runEvent('builder', 'failed', 6)))
  await waitFor(() => expect(quotaCalls()).toHaveLength(3))
})

test('an agent.updated event reloads the coding list, so a changed floor shows', async () => {
  const fetchMock = stub(codingQuota())
  const view = renderPill()
  await screen.findByRole('button', { name: /Claude plan quota: .* read after/ })
  const listCalls = () =>
    fetchMock.mock.calls.filter(([url]) => String(url) === '/api/coding-agents')
  expect(listCalls()).toHaveLength(1)
  act(() =>
    view.emit({
      type: 'agent.updated',
      seq: 2,
      ts: '2026-10-16T05:36:00.000Z',
      data: agent,
    } as StreamEvent),
  )
  await waitFor(() => expect(listCalls()).toHaveLength(2))
})

test('on a phone the footer keeps the words, drops the bars and gives the quota a 44px target', () => {
  const css = readFileSync(join(import.meta.dirname, 'bold-quota.css'), 'utf8')
  const phone = /@media \(max-width: 860px\) \{([\s\S]*)\}\s*$/.exec(css)?.[1] ?? ''
  expect(phone).toMatch(/\.bold-context-bar \.bold-context-track \{\s*display: none;/)
  expect(phone).toMatch(/\.bold-context-bar \.bold-quota-pill \{[\s\S]*min-height: 44px;/)
  expect(phone).toMatch(
    /\.bold-quota-pill \.bold-quota-track,[\s\S]*\.bold-quota-left-word,[\s\S]*\.bold-quota-group \{\s*display: none;/,
  )
  // It shrinks with an ellipsis instead of widening the page, and the Chat info targets are 44px.
  expect(phone).toMatch(
    /\.bold-quota-pill \{[\s\S]*overflow: hidden;[\s\S]*text-overflow: ellipsis;/,
  )
  expect(phone).toMatch(/\.bold-quota-link,[\s\S]*\.bold-info-toggle \{\s*min-height: 44px;/)
  expect(phone).toContain("content: '·';")
})
