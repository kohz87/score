import { expect, test } from 'vitest'
import {
  antigravityGroupOf,
  footerWindows,
  leftExact,
  leftPercent,
  planLabel,
  primaryQuotaWindow,
  quotaBelowFloor,
  quotaReadLine,
  quotaReadSentence,
  quotaSummary,
  quotaTone,
  quotaUsageLines,
  shortWindow,
  windowTitle,
} from './quota-view.ts'
import { codingQuota, NOW, SEEN_AT, WEEK_DAY } from '../../bold/quota/quota-test-data.ts'

const windows = codingQuota().windows

test('the footer names its plan, takes the first 5-hour window and keeps the compact window words', () => {
  expect(planLabel('claude-code')).toBe('Claude plan')
  expect(planLabel('codex')).toBe('ChatGPT plan')
  expect(planLabel('antigravity')).toBe('Antigravity')
  expect(primaryQuotaWindow(codingQuota().windows)?.name).toBe('5 hours')
  expect(primaryQuotaWindow([windows[1]!])?.name).toBe('week')
  expect(leftPercent(windows[0]!)).toBe(62)
  expect(shortWindow(windows[0]!)).toBe('5 h')
  expect(shortWindow(windows[1]!)).toBe('week')
  expect(windowTitle(windows[1]!)).toBe('Week')
  expect(windowTitle({ ...windows[0]!, group: 'Gemini Models' })).toBe('Gemini Models, 5 hours')
  expect(quotaSummary(codingQuota().windows)).toBe('62% 5 h · 80% week')
})

test('the bar is amber under 25% left, from the unrounded share; red is only the below-floor state', () => {
  expect(quotaTone(62)).toBe('ok')
  expect(quotaTone(25)).toBe('ok')
  expect(quotaTone(24.6)).toBe('low')
  expect(quotaTone(7)).toBe('low')
  expect(quotaTone(null)).toBe('ok')
  // 25.4% left shows as "25%" but is not under 25.
  expect(leftExact({ ...windows[0]!, usedPercent: 74.6 })).toBeCloseTo(25.4)
  expect(quotaTone(leftExact({ ...windows[0]!, usedPercent: 74.6 }))).toBe('ok')
  expect(leftExact({ ...windows[0]!, usedPercent: null })).toBeNull()
})

test('an unknown share is never read as a number: the primary window is the first known one', () => {
  const unknown = { ...windows[0]!, usedPercent: null }
  expect(primaryQuotaWindow([unknown, windows[1]!])?.name).toBe('week')
  expect(primaryQuotaWindow([unknown])).toBeNull()
  expect(quotaSummary([unknown, windows[1]!])).toBe('5 h not reported · 80% week')
  expect(quotaUsageLines(codingQuota([unknown]), NOW)).toEqual([
    '5 hours not reported · resets 5:40 am',
  ])
})

test('the footer of an Antigravity agent is its own model group; the default group when it has no model', () => {
  const quota = codingQuota(
    [
      { name: '5 hours', group: 'Gemini Models', usedPercent: 12, resetsAt: null },
      { name: '5 hours', group: 'Claude and GPT models', usedPercent: 46, resetsAt: null },
    ],
    { runtime: 'antigravity' },
  )
  expect(footerWindows(quota, null).group).toBe('Gemini Models')
  expect(footerWindows(quota, null).windows).toHaveLength(1)
  expect(footerWindows(quota, 'gpt-6').windows[0]?.group).toBe('Claude and GPT models')
  // Not a display id like "default": it maps to no group, so every window is shown.
  expect(footerWindows(quota, 'mystery').windows).toHaveLength(2)
  expect(footerWindows(codingQuota(), 'x').windows).toHaveLength(2)
  expect(quotaSummary(footerWindows(quota, null).windows, 'Gemini Models')).toBe(
    'Gemini Models: 88% 5 h',
  )
})

test('below-floor follows the guard: known, unexpired, and only the Antigravity model group', () => {
  const quota = codingQuota([
    { name: '5 hours', group: null, usedPercent: 93, resetsAt: '2026-10-16T06:00:00.000Z' },
    { name: 'week', group: null, usedPercent: 20, resetsAt: '2026-10-21T05:40:00.000Z' },
  ])
  expect(quotaBelowFloor(quota, 10, NOW, null)).toMatchObject({ leftPercent: 7 })
  expect(
    quotaBelowFloor(
      codingQuota([
        {
          name: '5 hours',
          group: null,
          usedPercent: 93,
          resetsAt: '2026-10-16T05:00:00.000Z',
        },
      ]),
      10,
      NOW,
      null,
    ),
  ).toBeNull()
  expect(quotaBelowFloor(quota, 0, NOW, null)).toBeNull()

  const antigravity = codingQuota(
    [
      {
        name: '5 hours',
        group: 'Gemini Models',
        usedPercent: 20,
        resetsAt: '2026-10-16T06:00:00.000Z',
      },
      {
        name: 'week',
        group: 'Claude and GPT models',
        usedPercent: 95,
        resetsAt: '2026-10-21T05:40:00.000Z',
      },
    ],
    { runtime: 'antigravity' },
  )
  expect(quotaBelowFloor(antigravity, 10, NOW, 'gemini-2.5-pro')).toBeNull()
  expect(quotaBelowFloor(antigravity, 10, NOW, 'claude-sonnet-4')).toMatchObject({
    window: { group: 'Claude and GPT models' },
    leftPercent: 5,
  })
  expect(antigravityGroupOf('gemini-4-argon-high')).toBe('Gemini 4 Argon')
  expect(antigravityGroupOf('gpt-6')).toBe('Claude and GPT models')
  expect(antigravityGroupOf(null)).toBe('Gemini Models')
})

test('the read sentence uses the turn time for Claude Code and Codex, relative time for Antigravity', () => {
  const quota = codingQuota()
  expect(quotaReadLine(quota, NOW)).toBe('read after the 5:05 am turn')
  expect(quotaReadSentence(quota, NOW)).toBe('Read after its 5:05 am turn.')
  expect(quotaReadSentence({ ...quota, runtime: 'antigravity' }, NOW)).toBe('Read 30 min ago.')
})

test('/usage lines keep each window name, share and reset', () => {
  expect(quotaUsageLines(codingQuota(), NOW)).toEqual([
    '5 hours 62% left · resets 5:40 am',
    `Week 80% left · resets ${WEEK_DAY}, 5:40 am`,
  ])
  expect(quotaUsageLines(codingQuota([], { seenAt: SEEN_AT }), NOW)).toEqual([])
})
