import { CodingQuotaSchema, type CodingUsage } from '@score/contract'
import { readFileSync } from 'node:fs'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DRIVERS } from '../../src/runtimes/coding/drivers.ts'
import {
  claudeQuotaFromRecord,
  codexQuotaFromTail,
  quotaFromUsage,
  readCodexQuota,
} from '../../src/runtimes/coding/quota.ts'

const fixtures = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/coding/${name}`, import.meta.url)), 'utf8')

// The record is the one Claude Code 2.1.301 sent (captured 2026-10-16), ids replaced.
const RATE_LIMIT = fixtures('claude-basic.jsonl')
  .split('\n')
  .find((line) => line.includes('rate_limit_event'))!

test('Claude Code: the rate_limit_event becomes 5-hour and weekly windows (utilization is a 0–1 fraction)', () => {
  expect(claudeQuotaFromRecord(JSON.parse(RATE_LIMIT))).toEqual([
    { name: '5 hours', group: null, usedPercent: 6, resetsAt: '2026-10-16T05:40:00.000Z' },
    { name: 'week', group: null, usedPercent: 78, resetsAt: '2026-10-17T03:00:00.000Z' },
  ])
})

test('Claude Code: a record without the windows, or with the wrong types, gives nothing', () => {
  expect(
    claudeQuotaFromRecord({ type: 'rate_limit_event', rate_limit_info: { status: 'ok' } }),
  ).toBe(null)
  expect(
    claudeQuotaFromRecord({
      type: 'rate_limit_event',
      rate_limit_info: { unifiedWindows: { five_hour: { utilization: 'x', resetsAt: 1 } } },
    }),
  ).toBe(null)
})

test('Claude Code driver: the latest rate-limit record is kept, the stream stays free of loss and no event comes of it', () => {
  const parser = DRIVERS['claude-code'].createParser({ cwd: '/work' })
  const events = fixtures('claude-basic.jsonl')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('{"_'))
    .flatMap((line) => parser.parse(line))
  expect(events.length).toBeGreaterThan(3)
  expect(parser.lossReason?.() ?? null).toBe(null)
  expect(parser.quota?.()?.map((window) => window.usedPercent)).toEqual([6, 78])
  // A later record replaces it; one that can't be read keeps the earlier numbers.
  const later = JSON.parse(RATE_LIMIT) as {
    rate_limit_info: { unifiedWindows: { five_hour: { utilization: number } } }
  }
  later.rate_limit_info.unifiedWindows.five_hour.utilization = 0.5
  parser.parse(JSON.stringify(later))
  expect(parser.quota?.()?.[0]?.usedPercent).toBe(50)
  parser.parse('{"type":"rate_limit_event","rate_limit_info":{}}')
  expect(parser.quota?.()?.[0]?.usedPercent).toBe(50)
})

let dir: string
let home: string
const THREAD = '0199aaaa-0000-7000-8000-000000000001'
const NOW = new Date(2026, 9, 16, 12, 0, 0)
const dayDir = () => join(home, 'sessions', '2026', '10', '16')
const logLine = (primary: number, secondary: number) =>
  `${JSON.stringify({
    timestamp: '2026-10-16T04:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: null,
      rate_limits: {
        primary: { used_percent: primary, window_minutes: 300, resets_at: 1792129200 },
        secondary: { used_percent: secondary, window_minutes: 10080, resets_at: 1792206000 },
      },
    },
  })}\n`
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-quota-'))
  home = join(dir, 'codex-home')
  mkdirSync(dayDir(), { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('Codex: the last rate_limits line of this run’s own log, in the tail', () => {
  writeFileSync(
    join(dayDir(), `rollout-2026-10-16T04-00-00-${THREAD}.jsonl`),
    `${'x'.repeat(300_000)}\n${logLine(3, 9)}{"type":"event_msg","payload":{"type":"agent_message"}}\n${logLine(12.5, 41)}{"type":"other"}\n`,
  )
  expect(readCodexQuota(home, THREAD, NOW)).toEqual([
    { name: '5 hours', group: null, usedPercent: 12.5, resetsAt: '2026-10-16T05:40:00.000Z' },
    { name: 'week', group: null, usedPercent: 41, resetsAt: '2026-10-17T03:00:00.000Z' },
  ])
})

test('Codex: other threads’ logs and other Codex files are never opened', () => {
  // Unreadable decoys: opening any of them would fail the test through the thrown error being swallowed as "unknown",
  // so the real file must still be the one that answers.
  const decoy = join(
    dayDir(),
    'rollout-2026-10-16T03-00-00-0199bbbb-0000-7000-8000-000000000002.jsonl',
  )
  writeFileSync(decoy, logLine(99, 99))
  chmodSync(decoy, 0o000)
  writeFileSync(join(home, 'auth.json'), '{"rate_limits":{}}')
  chmodSync(join(home, 'auth.json'), 0o000)
  expect(readCodexQuota(home, '0199bbbb-0000-7000-8000-000000000003', NOW)).toBe(null)
  writeFileSync(join(dayDir(), `rollout-2026-10-16T04-00-00-${THREAD}.jsonl`), logLine(7, 8))
  expect(readCodexQuota(home, THREAD, NOW)?.map((window) => window.usedPercent)).toEqual([7, 8])
})

test('Codex: a symlink named like the log is refused, as is a directory', () => {
  const secret = join(dir, 'elsewhere.jsonl')
  writeFileSync(secret, logLine(50, 50))
  symlinkSync(secret, join(dayDir(), `rollout-2026-10-16T04-00-00-${THREAD}.jsonl`))
  expect(readCodexQuota(home, THREAD, NOW)).toBe(null)
  const other = '0199cccc-0000-7000-8000-000000000004'
  mkdirSync(join(dayDir(), `rollout-2026-10-16T04-00-00-${other}.jsonl`))
  expect(readCodexQuota(home, other, NOW)).toBe(null)
})

test('Codex: a missing log, an unknown format or a hostile thread id is "unknown"', () => {
  expect(readCodexQuota(home, THREAD, NOW)).toBe(null)
  writeFileSync(
    join(dayDir(), `rollout-2026-10-16T04-00-00-${THREAD}.jsonl`),
    '{"payload":{"rate_limits":{"primary":{"used_percent":"lots"}}}}\n{"rate_limits":null}\n',
  )
  expect(readCodexQuota(home, THREAD, NOW)).toBe(null)
  expect(readCodexQuota(home, '../../etc/passwd', NOW)).toBe(null)
  expect(readCodexQuota(join(dir, 'no-such-home'), THREAD, NOW)).toBe(null)
})

test('Codex: windows of an unfamiliar length are not shown; a lone window still is', () => {
  const tail = `{"payload":{"rate_limits":{"primary":{"used_percent":20,"window_minutes":60,"resets_at":1792129200},"secondary":{"used_percent":5,"window_minutes":10080}}}}\n`
  expect(codexQuotaFromTail(tail)).toEqual([
    { name: 'week', group: null, usedPercent: 5, resetsAt: null },
  ])
})

test('Antigravity: "remaining" becomes "used" per model group; a reset that is not a date is dropped', () => {
  const usage: CodingUsage = {
    runtime: 'antigravity',
    fetchedAt: '2026-10-16T00:00:00.000Z',
    groups: [
      {
        name: 'Gemini Models',
        fiveHourRemainingPercent: 87,
        fiveHourResets: '2026-10-11T04:43:48Z',
        weeklyRemainingPercent: 75,
        weeklyResets: 'resets in 3h',
      },
      {
        name: 'Gemini 4 Argon',
        fiveHourRemainingPercent: null,
        fiveHourResets: null,
        weeklyRemainingPercent: 45,
        weeklyResets: '2026-10-23T01:02:23Z',
      },
      {
        name: 'Other',
        fiveHourRemainingPercent: null,
        fiveHourResets: null,
        weeklyRemainingPercent: null,
        weeklyResets: null,
      },
    ],
    text: 't',
  }
  const quota = quotaFromUsage(usage)
  expect(CodingQuotaSchema.safeParse(quota).success).toBe(true)
  expect(quota.source).toBe('usage')
  expect(quota.windows).toEqual([
    {
      name: '5 hours',
      group: 'Gemini Models',
      usedPercent: 13,
      resetsAt: '2026-10-11T04:43:48.000Z',
    },
    { name: 'week', group: 'Gemini Models', usedPercent: 25, resetsAt: null },
    // agy 1.4.0: a weekly-only group gets no empty 5-hour meter.
    {
      name: 'week',
      group: 'Gemini 4 Argon',
      usedPercent: 55,
      resetsAt: '2026-10-23T01:02:23.000Z',
    },
    { name: '5 hours', group: 'Other', usedPercent: null, resetsAt: null },
  ])
})
