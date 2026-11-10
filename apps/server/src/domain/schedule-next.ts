// Decision 183: when a recipe's schedule fires next. A schedule is what Hermes' scheduler takes, so recipes and agents'
// repeating jobs read the same: a 5-field cron expression (minute hour day-of-month month day-of-week; `*`, lists,
// ranges and steps; day-of-month and day-of-week match either when both are set, as cron does) or `every <n><m|h|d>`,
// in an IANA time zone. No dependency: the expressions Score writes are small.

type Field = Set<number>

function parseField(text: string, min: number, max: number): Field | null {
  const out: Field = new Set()
  for (const part of text.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!match) return null
    const step = match[4] ? Number(match[4]) : 1
    const from = match[1] === '*' ? min : Number(match[2])
    const to =
      match[1] === '*' ? max : match[3] !== undefined ? Number(match[3]) : match[4] ? max : from
    if (step < 1 || from < min || to > max || from > to) return null
    for (let value = from; value <= to; value += step) out.add(value)
  }
  return out
}

export type ParsedSchedule =
  | { kind: 'every'; ms: number }
  | {
      kind: 'cron'
      minutes: number[]
      hours: number[]
      days: Field
      months: Field
      weekdays: Field
      daysSet: boolean
      weekdaysSet: boolean
    }

export function parseSchedule(text: string): ParsedSchedule | null {
  const every = /^every (\d{1,4})([mhd])$/.exec(text.trim())
  if (every) {
    const n = Number(every[1])
    if (n < 1) return null
    return {
      kind: 'every',
      ms: n * { m: 60_000, h: 3_600_000, d: 86_400_000 }[every[2] as 'm' | 'h' | 'd'],
    }
  }
  const fields = text.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string]
  const minutes = parseField(m, 0, 59)
  const hours = parseField(h, 0, 23)
  const days = parseField(dom, 1, 31)
  const months = parseField(mon, 1, 12)
  // Sunday is 0 or 7 (`1-7` is Monday to Sunday).
  const weekdays = parseField(dow, 0, 7)
  if (weekdays?.delete(7)) weekdays.add(0)
  if (!minutes || !hours || !days || !months || !weekdays) return null
  return {
    kind: 'cron',
    minutes: [...minutes].sort((a, b) => a - b),
    hours: [...hours].sort((a, b) => a - b),
    days,
    months,
    weekdays,
    daysSet: dom !== '*',
    weekdaysSet: dow !== '*',
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()
/** One formatter per zone: building one is the expensive part of every offset. */
function formatter(timeZone: string): Intl.DateTimeFormat {
  let made = formatters.get(timeZone)
  if (!made) {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, made)
  }
  return made
}

/** The zone's offset from UTC at a moment, in ms (positive east of UTC). */
function offsetAt(timeZone: string, utcMs: number): number {
  const parts = formatter(timeZone).formatToParts(new Date(utcMs))
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  )
  return asUtc - Math.floor(utcMs / 1000) * 1000
}

/**
 * A wall-clock time in the zone as a UTC moment. A time the clocks skip (spring forward) moves on to the same minutes
 * after the jump; a time that happens twice (fall back) is the first of the two, so it fires once.
 */
function zonedToUtc(
  timeZone: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const before = guess - offsetAt(timeZone, guess - 6 * 3_600_000)
  const after = guess - offsetAt(timeZone, guess + 6 * 3_600_000)
  const reads = (at: number) => at + offsetAt(timeZone, at) === guess
  const real = [...new Set([before, after])].filter(reads).sort((a, b) => a - b)
  // Neither reading exists: the clocks jumped over it. The earlier offset lands the same minutes after the jump.
  return real[0] ?? before
}

function localDate(
  timeZone: string,
  utcMs: number,
): { y: number; mo: number; d: number; h: number; mi: number } {
  const local = new Date(utcMs + offsetAt(timeZone, utcMs))
  return {
    y: local.getUTCFullYear(),
    mo: local.getUTCMonth() + 1,
    d: local.getUTCDate(),
    h: local.getUTCHours(),
    mi: local.getUTCMinutes(),
  }
}

/**
 * The first fire strictly after `after`, or null when the schedule can't be read or never fires within a year.
 * `every` counts from `anchor` (the last fire, or when the schedule was set).
 */
export function nextFire(
  text: string,
  timeZone: string,
  after: Date,
  anchor: Date = after,
): Date | null {
  const schedule = parseSchedule(text)
  if (!schedule) return null
  if (schedule.kind === 'every') {
    const start = anchor.getTime()
    const steps = Math.max(1, Math.floor((after.getTime() - start) / schedule.ms) + 1)
    return new Date(start + steps * schedule.ms)
  }
  const start = localDate(timeZone, after.getTime())
  // Eight years: long enough for a 29 February schedule; a month check skips most days cheaply.
  for (let day = 0; day < 366 * 8; day += 1) {
    const date = new Date(Date.UTC(start.y, start.mo - 1, start.d + day))
    const y = date.getUTCFullYear()
    const mo = date.getUTCMonth() + 1
    const d = date.getUTCDate()
    if (!schedule.months.has(mo)) continue
    const dayOk = schedule.days.has(d)
    const weekdayOk = schedule.weekdays.has(date.getUTCDay())
    const matches =
      schedule.daysSet && schedule.weekdaysSet
        ? dayOk || weekdayOk
        : schedule.daysSet
          ? dayOk
          : schedule.weekdaysSet
            ? weekdayOk
            : true
    if (!matches) continue
    for (const h of schedule.hours)
      for (const mi of schedule.minutes) {
        // Today's times before now can't be next (an hour of slack covers a clock change).
        if (day === 0 && h * 60 + mi < start.h * 60 + start.mi - 60) continue
        const at = zonedToUtc(timeZone, y, mo, d, h, mi)
        if (at > after.getTime()) return new Date(at)
      }
  }
  return null
}
