// @vitest-environment jsdom
import type { CodingQuota } from '@score/contract'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { leftPercent, quotaLine, QuotaMeters, resetText, seenText } from './QuotaMeters.tsx'

afterEach(cleanup)

const quota = (windows: CodingQuota['windows'], source: CodingQuota['source'] = 'turn') =>
  ({ runtime: 'claude-code', seenAt: '2026-10-16T05:30:00.000Z', source, windows }) as CodingQuota

test('a meter shows "% left" from the used share, with the reset time and "as of"', () => {
  process.env.TZ = 'Asia/Singapore'
  render(
    <QuotaMeters
      runtime="claude-code"
      quota={quota([
        { name: '5 hours', group: null, usedPercent: 6, resetsAt: '2026-10-16T05:40:00.000Z' },
        { name: 'week', group: null, usedPercent: 78, resetsAt: '2099-01-01T05:40:00.000Z' },
      ])}
    />,
  )
  const fiveHours = screen.getByRole('meter', { name: '5 hours left' })
  expect(fiveHours.getAttribute('aria-valuenow')).toBe('94')
  expect(fiveHours.getAttribute('aria-valuetext')).toBe('94% left')
  expect(screen.getByText('94% left')).toBeDefined()
  expect(screen.getByText('22% left')).toBeDefined()
  expect(screen.getByText(/^resets (1:40 pm|\d+ \w+, 1:40 pm)$/)).toBeDefined()
  expect(screen.getByText(/^As of /)).toBeDefined()
})

test('an unknown share is "?", not a number, and the bar has no value', () => {
  render(
    <QuotaMeters
      runtime="codex"
      quota={quota([{ name: 'week', group: null, usedPercent: null, resetsAt: null }])}
    />,
  )
  expect(screen.getByText('? left')).toBeDefined()
  const meter = screen.getByRole('meter', { name: 'week left' })
  expect(meter.hasAttribute('aria-valuenow')).toBe(false)
  expect(meter.getAttribute('aria-valuetext')).toBe('unknown')
})

test('Antigravity groups name their model group and do not claim an "as of" time', () => {
  render(
    <QuotaMeters
      runtime="antigravity"
      quota={quota(
        [{ name: '5 hours', group: 'Gemini Models', usedPercent: 13, resetsAt: null }],
        'usage',
      )}
    />,
  )
  expect(screen.getByRole('meter', { name: 'Gemini Models, 5 hours left' })).toBeDefined()
  expect(screen.queryByText(/As of/)).toBeNull()
})

test('no reading yet and unreadable limits say so in plain words', () => {
  const { rerender } = render(<QuotaMeters runtime="codex" quota={null} />)
  expect(
    screen.getByText('Codex reports its limits after its first reply. Nothing yet.'),
  ).toBeDefined()
  rerender(<QuotaMeters runtime="codex" quota={quota([])} />)
  expect(screen.getByText('Codex didn’t report limits Score can read.')).toBeDefined()
})

test('helpers: left share is clamped, the compact line and relative times', () => {
  expect(
    leftPercent({ name: 'week', group: null, usedPercent: 130 as number, resetsAt: null }),
  ).toBe(0)
  expect(
    quotaLine(
      quota([
        { name: '5 hours', group: 'Gemini Models', usedPercent: 13, resetsAt: null },
        { name: 'week', group: null, usedPercent: null, resetsAt: null },
      ]),
    ),
  ).toBe('Gemini Models 5 hours 87% left · week ? left')
  expect(resetText(null)).toBe(null)
  expect(resetText('not a date')).toBe(null)
  const now = new Date('2026-10-16T06:00:00.000Z')
  expect(seenText('2026-10-16T05:48:00.000Z', now)).toBe('12 min ago')
  expect(seenText('2026-10-16T05:59:50.000Z', now)).toBe('just now')
})
