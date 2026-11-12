import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { disposeRoomTest, jsonResponse, mockFetch, renderInRoom } from '../room/room-test-utils.tsx'
import { DirectQuotaInfo } from './DirectQuotaInfo.tsx'
import { codingQuota, codingRecord, codingSummaryAgent, NOW, WEEK_DAY } from './quota-test-data.ts'

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

function stub(
  quota: ReturnType<typeof codingQuota> | null,
  record = codingRecord(),
  quotaStatus = 200,
) {
  vi.stubGlobal(
    'fetch',
    mockFetch((url) => {
      if (url === '/api/coding-agents/builder/quota')
        return quotaStatus === 200
          ? jsonResponse({ quota })
          : jsonResponse({ error: { code: 'unreadable', message: 'No reading.' } }, quotaStatus)
      if (url === '/api/coding-agents') return jsonResponse({ items: [record] })
      return jsonResponse({}, 404)
    }),
  )
}

function renderInfo(onNavigate = vi.fn()) {
  return renderInRoom(
    <DirectQuotaInfo agent={agent} runtime="claude-code" onNavigate={onNavigate} />,
  )
}

async function quotaSection(title = 'Quota · Claude plan') {
  const button = await screen.findByRole('button', { name: new RegExp(title) })
  const section = button.closest('section')!
  await waitFor(() => expect(within(section).queryByText('Reading the quota…')).toBeNull())
  return section
}

test('Chat info lists every window with its share, bar and reset, then how it was read and shared', async () => {
  const onNavigate = vi.fn()
  stub(codingQuota())
  renderInfo(onNavigate)
  const section = await quotaSection()

  expect(within(section).getByText('5 hours')).toBeTruthy()
  expect(within(section).getByText('Week')).toBeTruthy()
  expect(within(section).getByText('62% left')).toBeTruthy()
  expect(within(section).getByText('80% left')).toBeTruthy()
  expect(within(section).getAllByText('resets 5:40 am')).toHaveLength(1)
  expect(within(section).getByText(`resets ${WEEK_DAY}, 5:40 am`)).toBeTruthy()
  expect(
    within(section).getByRole('meter', { name: '5 hours left' }).getAttribute('data-tone'),
  ).toBe('ok')
  expect(
    (within(section).getByRole('meter', { name: '5 hours left' }) as HTMLElement)
      .querySelector('.bold-quota-fill')
      ?.getAttribute('style'),
  ).toContain('width: 62%')
  expect(within(section).getByText('Read after its 5:05 am turn.')).toBeTruthy()
  expect(within(section).getByText(/Below 10% \(its floor\)/).textContent).toContain(
    'Change the floor',
  )
  expect(within(section).getByRole('link', { name: 'Change the floor' }).getAttribute('href')).toBe(
    '/b/agents/builder#agent-safety',
  )
  expect(
    within(section).getByText('Shared with every agent on the same Claude login.'),
  ).toBeTruthy()

  fireEvent.click(within(section).getByRole('link', { name: 'Change the floor' }))
  expect(onNavigate).toHaveBeenCalledOnce()
})

test('under 25% left the Info bar is amber', async () => {
  stub(
    codingQuota([
      { name: '5 hours', group: null, usedPercent: 85, resetsAt: '2026-10-16T05:40:00.000Z' },
    ]),
    codingRecord({ quotaFloorPercent: 5 }),
  )
  renderInfo()
  const section = await quotaSection()
  expect(within(section).getByText('15% left')).toBeTruthy()
  expect(
    within(section).getByRole('meter', { name: '5 hours left' }).getAttribute('data-tone'),
  ).toBe('low')
})

test('below its floor Chat info adds the protected stop notice and both ways out', async () => {
  stub(
    codingQuota([
      { name: '5 hours', group: null, usedPercent: 93, resetsAt: '2026-10-16T05:40:00.000Z' },
    ]),
  )
  renderInfo()
  const section = await quotaSection()
  const notice = within(section)
    .getByText(/Score won’t start new work for Builder until the 5-hour window resets/)
    .closest('.bold-quota-floor-note') as HTMLElement
  expect(notice.getAttribute('data-protected')).toBe('block')
  expect(notice.textContent).toContain('resets at 5:40 am')
  expect(notice.textContent).toContain('What’s running finishes.')
  expect(within(notice).getByRole('link', { name: 'Change the floor' })).toBeTruthy()
  expect(within(notice).getByRole('link', { name: 'Use another agent' }).getAttribute('href')).toBe(
    '/b/agents',
  )
})

test('no reading yet is a sentence, not an empty meter', async () => {
  stub(null)
  renderInfo()
  const section = await quotaSection()
  expect(within(section).getByText('Quota · shows after its first turn.')).toBeTruthy()
  expect(within(section).queryByRole('meter')).toBeNull()
})

test('a read error keeps its words and draws no bar', async () => {
  stub(null, codingRecord(), 500)
  renderInfo()
  const section = await quotaSection()
  expect(within(section).getByText('Quota couldn’t be read.')).toBeTruthy()
  expect(within(section).queryByRole('meter')).toBeNull()
})

test('Antigravity names each model group and reads its live age in minutes', async () => {
  const antigravity = codingSummaryAgent('antigravity', { model: null })
  stub(
    codingQuota(
      [
        {
          name: '5 hours',
          group: 'Gemini Models',
          usedPercent: 12,
          resetsAt: '2026-10-16T05:40:00.000Z',
        },
        {
          name: 'week',
          group: 'Gemini 4 Argon',
          usedPercent: 46,
          resetsAt: '2026-10-21T05:40:00.000Z',
        },
      ],
      { runtime: 'antigravity', source: 'usage' },
    ),
    codingRecord({ runtime: 'antigravity', model: 'gemini-2.5-pro' }),
  )
  renderInRoom(<DirectQuotaInfo agent={antigravity} runtime="antigravity" />)
  const section = await quotaSection('Quota · Antigravity')

  expect(within(section).getByRole('meter', { name: 'Gemini Models, 5 hours left' })).toBeTruthy()
  expect(within(section).getByRole('meter', { name: 'Gemini 4 Argon, Week left' })).toBeTruthy()
  expect(within(section).getByText('Read 30 min ago.')).toBeTruthy()
  expect(
    within(section).getByText('Shared with every agent on the same Antigravity login.'),
  ).toBeTruthy()
})
