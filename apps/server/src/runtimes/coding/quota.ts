import type { CodingQuota, CodingQuotaWindow, CodingUsage } from '@score/contract'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

// CLI quota meters (PLAN 8.1, decision 82). Each CLI's own number is reduced to `{ usedPercent, resetsAt }` per window
// and nothing else is kept from the record it came in.

export type QuotaWindows = CodingQuotaWindow[]

const clampPercent = (value: number): number =>
  Math.min(100, Math.max(0, Math.round(value * 10) / 10))
const isoFromSeconds = (seconds: number): string | null => {
  const date = new Date(seconds * 1000)
  return Number.isFinite(date.getTime()) && seconds > 0 ? date.toISOString() : null
}

const ClaudeWindow = z.object({ utilization: z.number().finite(), resetsAt: z.number().finite() })
const ClaudeRateLimit = z.object({
  type: z.literal('rate_limit_event'),
  rate_limit_info: z.object({
    unifiedWindows: z.object({
      five_hour: ClaudeWindow.optional(),
      seven_day: ClaudeWindow.optional(),
    }),
  }),
})

/** Claude Code's `rate_limit_event` (2.1.301): `unifiedWindows.five_hour|seven_day { utilization 0–1, resetsAt epoch s }`. */
export function claudeQuotaFromRecord(value: unknown): QuotaWindows | null {
  const parsed = ClaudeRateLimit.safeParse(value)
  if (!parsed.success) return null
  const { five_hour: five, seven_day: seven } = parsed.data.rate_limit_info.unifiedWindows
  const windows: QuotaWindows = []
  const add = (
    name: CodingQuotaWindow['name'],
    window: z.infer<typeof ClaudeWindow> | undefined,
  ) => {
    if (window)
      windows.push({
        name,
        group: null,
        usedPercent: clampPercent(window.utilization * 100),
        resetsAt: isoFromSeconds(window.resetsAt),
      })
  }
  add('5 hours', five)
  add('week', seven)
  return windows.length > 0 ? windows : null
}

const CodexWindow = z.object({
  used_percent: z.number().finite(),
  window_minutes: z.number().finite().optional(),
  resets_at: z.number().finite().optional(),
})
const CodexRateLimits = z.object({
  primary: CodexWindow.nullish(),
  secondary: CodexWindow.nullish(),
})
const TAIL_BYTES = 256 * 1024

/** A window of about 5 hours is "5 hours", one of about a week is "week"; any other length is not shown. */
function codexName(minutes: number | undefined): CodingQuotaWindow['name'] | null {
  if (minutes === undefined) return null
  if (Math.abs(minutes - 300) <= 30) return '5 hours'
  if (Math.abs(minutes - 10080) <= 1440) return 'week'
  return null
}

/** The last `rate_limits` object in a log tail (the first line of a tail may be cut and is skipped). */
export function codexQuotaFromTail(tail: string): QuotaWindows | null {
  const lines = tail.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    if (!line.includes('rate_limits')) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    const found = findRateLimits(value)
    if (!found) continue
    const windows: QuotaWindows = []
    for (const window of [found.primary, found.secondary]) {
      const name = window ? codexName(window.window_minutes) : null
      if (window && name)
        windows.push({
          name,
          group: null,
          usedPercent: clampPercent(window.used_percent),
          resetsAt: window.resets_at === undefined ? null : isoFromSeconds(window.resets_at),
        })
    }
    return windows.length > 0 ? windows : null
  }
  return null
}

/** `rate_limits` sits inside the event payload (`payload.rate_limits`, or deeper under `info`): look a few levels down. */
function findRateLimits(value: unknown, depth = 0): z.infer<typeof CodexRateLimits> | null {
  if (value === null || typeof value !== 'object' || depth > 3) return null
  const record = value as Record<string, unknown>
  if ('rate_limits' in record) {
    const parsed = CodexRateLimits.safeParse(record.rate_limits)
    return parsed.success ? parsed.data : null
  }
  for (const child of Object.values(record)) {
    const found = findRateLimits(child, depth + 1)
    if (found) return found
  }
  return null
}

const SAFE_THREAD = /^[A-Za-z0-9-]{8,80}$/

/**
 * The quota Codex wrote into the session log of the run Score started (decision 82): only
 * `$CODEX_HOME/sessions/<y>/<m>/<d>/rollout-*-<threadId>.jsonl` is opened, read-only, tail only. The directories are listed by
 * name (never opened as files); only an entry that ends with this run's thread id is a candidate, and it must be a regular
 * file owned by this user, opened with O_NOFOLLOW. Anything else, or an unrecognised format, is "unknown" (null).
 */
export function readCodexQuota(
  codexHome: string | undefined,
  threadId: string,
  now: Date,
): QuotaWindows | null {
  if (!SAFE_THREAD.test(threadId)) return null
  const root = join(
    codexHome && codexHome.length > 0 ? codexHome : join(homedir(), '.codex'),
    'sessions',
  )
  const suffix = `-${threadId}.jsonl`
  // The run just ended, so its file is in today's folder, or yesterday's when the day changed meanwhile (UTC and local).
  const days = new Set<string>()
  for (const offset of [0, -1, 1]) {
    const at = new Date(now.getTime() + offset * 86_400_000)
    days.add(`${at.getFullYear()}/${pad(at.getMonth() + 1)}/${pad(at.getDate())}`)
    days.add(`${at.getUTCFullYear()}/${pad(at.getUTCMonth() + 1)}/${pad(at.getUTCDate())}`)
  }
  for (const day of days) {
    const dir = join(root, day)
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    const name = names.find((entry) => entry.startsWith('rollout-') && entry.endsWith(suffix))
    if (!name) continue
    const tail = readTail(join(dir, name))
    return tail === null ? null : codexQuotaFromTail(tail)
  }
  return null
}

const pad = (value: number): string => String(value).padStart(2, '0')

function readTail(path: string): string | null {
  let fd: number | null = null
  try {
    const before = lstatSync(path)
    if (!before.isFile() || before.uid !== process.getuid?.()) return null
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== before.uid || stat.ino !== before.ino) return null
    const length = Math.min(stat.size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, stat.size - length + read)
      if (count === 0) break
      read += count
    }
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** Antigravity's `/usage` reading as meters: its "remaining" share becomes "used"; a reset time that isn't a date is dropped. */
export function quotaFromUsage(usage: CodingUsage): CodingQuota {
  const resets = (value: string | null): string | null => {
    if (value === null) return null
    const time = Date.parse(value)
    return Number.isNaN(time) ? null : new Date(time).toISOString()
  }
  const windows: QuotaWindows = []
  for (const group of usage.groups) {
    const name = group.name.slice(0, 100)
    if (!name) continue
    windows.push({
      name: '5 hours',
      group: name,
      usedPercent:
        group.fiveHourRemainingPercent === null ? null : 100 - group.fiveHourRemainingPercent,
      resetsAt: resets(group.fiveHourResets),
    })
    if (group.weeklyRemainingPercent !== null || group.weeklyResets !== null)
      windows.push({
        name: 'week',
        group: name,
        usedPercent:
          group.weeklyRemainingPercent === null ? null : 100 - group.weeklyRemainingPercent,
        resetsAt: resets(group.weeklyResets),
      })
  }
  return {
    runtime: usage.runtime,
    seenAt: usage.fetchedAt,
    windows: windows.slice(0, 24),
    source: 'usage',
  }
}
