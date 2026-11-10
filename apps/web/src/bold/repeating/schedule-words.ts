// Tasks › Repeating (TR.2): a schedule in the words the panel speaks. The panel builds five shapes; anything else is
// shown as typed. `parseSchedule` and `buildSchedule` round-trip those shapes exactly, so an edit that changes nothing
// sends nothing.

export type ScheduleKind = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom'

export type ParsedSchedule = {
  kind: ScheduleKind
  /** `HH:MM`, for the four timed shapes. */
  time: string
  /** Weekly: 0 (Sunday) to 6; monthly: the day of the month, 1 to 28. */
  day: number
  /** Custom: the text as typed. */
  text: string
}

const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
export const WEEKDAY_NAMES = DAYS
export const DEFAULT_TIME = '08:00'

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (m: string, h: string) => `${pad(Number(h))}:${pad(Number(m))}`
const whole = /^\d{1,2}$/

export function parseSchedule(schedule: string): ParsedSchedule {
  const text = schedule.trim()
  const custom: ParsedSchedule = { kind: 'custom', time: DEFAULT_TIME, day: 1, text }
  const fields = text.split(/\s+/)
  if (fields.length !== 5) return custom
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string]
  if (!whole.test(m) || !whole.test(h) || Number(m) > 59 || Number(h) > 23 || mon !== '*')
    return custom
  const time = clock(m, h)
  if (dom === '*' && dow === '*') return { kind: 'daily', time, day: 1, text }
  if (dom === '*' && dow === '1-5') return { kind: 'weekdays', time, day: 1, text }
  if (dom === '*' && /^[0-6]$/.test(dow)) return { kind: 'weekly', time, day: Number(dow), text }
  if (dow === '*' && whole.test(dom) && Number(dom) >= 1 && Number(dom) <= 28)
    return { kind: 'monthly', time, day: Number(dom), text }
  return custom
}

/** `HH:MM` as typed to its two numbers, or null when it isn't a time. */
export function splitTime(time: string): [number, number] | null {
  const found = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!found) return null
  const h = Number(found[1])
  const m = Number(found[2])
  return h <= 23 && m <= 59 ? [h, m] : null
}

export function buildSchedule(kind: ScheduleKind, time: string, day: number, custom: string) {
  if (kind === 'custom') return custom.trim()
  const parts = splitTime(time)
  if (!parts) return null
  const [h, m] = parts
  const head = `${m} ${h}`
  if (kind === 'daily') return `${head} * * *`
  if (kind === 'weekdays') return `${head} * * 1-5`
  if (kind === 'weekly') return `${head} * * ${day}`
  return `${head} ${day} * *`
}

const ordinal = (n: number) => {
  const tail = n % 100
  if (tail >= 11 && tail <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
}

const UNIT: Record<string, string> = { m: 'minute', h: 'hour', d: 'day' }

/** "Every day, 08:00", "Weekdays, 08:00", "Mondays, 09:00", "1st of the month, 08:00", "Every 2 hours"; else as typed. */
export function scheduleWords(schedule: string): string {
  const every = /^every (\d{1,4})([mhd])$/.exec(schedule.trim())
  if (every) {
    const n = Number(every[1])
    const unit = UNIT[every[2]!]!
    return n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`
  }
  const p = parseSchedule(schedule)
  if (p.kind === 'daily') return `Every day, ${p.time}`
  if (p.kind === 'weekdays') return `Weekdays, ${p.time}`
  if (p.kind === 'weekly') return `${DAYS[p.day]}, ${p.time}`
  if (p.kind === 'monthly') return `${ordinal(p.day)} of the month, ${p.time}`
  return schedule
}

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())

/** A time in the person's zone: "tomorrow 08:00", "Fri 09:00", "Dec 1 08:00". */
export function dayWords(date: Date, now: Date) {
  const clockText = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const days = Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / 86_400_000)
  if (days <= 0) return `today ${clockText}`
  if (days === 1) return `tomorrow ${clockText}`
  if (days < 7) return `${SHORT_DAYS[date.getDay()]} ${clockText}`
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${clockText}`
}

/** The list's "next in 14 h" / "next Fri 17:00" from Hermes's own next fire time. */
export function nextWords(nextRunAt: string | null, now: Date): string | null {
  if (!nextRunAt) return null
  const date = new Date(nextRunAt)
  const minutes = Math.round((date.getTime() - now.getTime()) / 60_000)
  if (Number.isNaN(minutes)) return null
  if (minutes < 1) return 'next: due now'
  if (minutes < 60) return `next in ${minutes} min`
  if (minutes < 24 * 60) return `next in ${Math.round(minutes / 60)} h`
  return `next ${dayWords(date, now)}`
}

/** The panel's own preview of the next fire for the four timed shapes, in the browser's zone; null for Custom. */
export function previewNext(kind: ScheduleKind, time: string, day: number, now: Date) {
  const parts = splitTime(time)
  if (kind === 'custom' || !parts) return null
  for (let ahead = 0; ahead < 400; ahead += 1) {
    const date = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + ahead,
      parts[0],
      parts[1],
    )
    if (date <= now) continue
    const weekday = date.getDay()
    if (kind === 'weekdays' && (weekday === 0 || weekday === 6)) continue
    if (kind === 'weekly' && weekday !== day) continue
    if (kind === 'monthly' && date.getDate() !== day) continue
    return dayWords(date, now)
  }
  return null
}

/** The browser's IANA zone, sent with every schedule the panel saves. */
export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

/** "GMT+8", the mock-up's short form of the zone. */
export function zoneLabel(now: Date) {
  const part = new Intl.DateTimeFormat('en', { timeZoneName: 'shortOffset' })
    .formatToParts(now)
    .find((item) => item.type === 'timeZoneName')
  return part?.value ?? browserZone()
}
