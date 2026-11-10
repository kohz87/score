// Decision 183: a schedule (a cron expression or `every <n><m|h|d>`) in words, and back from the presets the editing
// panel offers. TR.2's Repeating page needs the same words; this file is the one both read.

export type SchedulePreset = 'day' | 'weekdays' | 'week' | 'month' | 'custom'

export type ScheduleDraft = {
  preset: SchedulePreset
  /** 24-hour "HH:MM". */
  time: string
  /** 0 = Sunday … 6 = Saturday (`week`). */
  weekday: number
  /** 1–31 (`month`). */
  monthDay: number
  /** The schedule as typed (`custom`). */
  custom: string
}

export const PRESETS: { id: SchedulePreset; label: string }[] = [
  { id: 'day', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'week', label: 'Every week' },
  { id: 'month', label: 'Every month' },
  { id: 'custom', label: 'Custom' },
]

export const WEEKDAYS = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
]

const pad = (value: number) => String(value).padStart(2, '0')
const NUMBER = /^\d{1,2}$/

export const DEFAULT_DRAFT: ScheduleDraft = {
  preset: 'day',
  time: '08:00',
  weekday: 1,
  monthDay: 1,
  custom: '',
}

function ordinal(day: number) {
  const tens = day % 100
  if (tens >= 11 && tens <= 13) return `${day}th`
  return `${day}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th'}`
}

/** The preset a schedule text is one of, or `custom` with the text itself. */
export function draftFromSchedule(text: string | null): ScheduleDraft {
  if (!text) return { ...DEFAULT_DRAFT }
  const fields = text.trim().split(/\s+/)
  const [minute, hour, day, month, weekday] = fields
  if (
    fields.length === 5 &&
    NUMBER.test(minute ?? '') &&
    NUMBER.test(hour ?? '') &&
    Number(minute) < 60 &&
    Number(hour) < 24 &&
    month === '*'
  ) {
    const time = `${pad(Number(hour))}:${pad(Number(minute))}`
    const base = { ...DEFAULT_DRAFT, time, custom: text }
    if (day === '*' && weekday === '*') return { ...base, preset: 'day' }
    if (day === '*' && weekday === '1-5') return { ...base, preset: 'weekdays' }
    if (day === '*' && /^[0-7]$/.test(weekday ?? ''))
      return { ...base, preset: 'week', weekday: Number(weekday) % 7 }
    if (weekday === '*' && NUMBER.test(day ?? '') && Number(day) >= 1 && Number(day) <= 31)
      return { ...base, preset: 'month', monthDay: Number(day) }
  }
  return { ...DEFAULT_DRAFT, preset: 'custom', custom: text }
}

/** The schedule text a draft stands for. */
export function scheduleFromDraft(draft: ScheduleDraft): string {
  if (draft.preset === 'custom') return draft.custom.trim()
  const [hour = '8', minute = '0'] = draft.time.split(':')
  const at = `${Number(minute)} ${Number(hour)}`
  switch (draft.preset) {
    case 'day':
      return `${at} * * *`
    case 'weekdays':
      return `${at} * * 1-5`
    case 'week':
      return `${at} * * ${draft.weekday}`
    default:
      return `${at} ${draft.monthDay} * *`
  }
}

/** "Fridays at 16:00", "Weekdays at 08:00", "Every 2 hours"; a schedule that isn't a preset reads as it was written. */
export function describeSchedule(text: string): string {
  const every = /^every (\d{1,4})([mhd])$/.exec(text.trim())
  if (every) {
    const count = Number(every[1])
    const unit = { m: 'minute', h: 'hour', d: 'day' }[every[2] as 'm' | 'h' | 'd']
    return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`
  }
  const draft = draftFromSchedule(text)
  switch (draft.preset) {
    case 'day':
      return `Every day at ${draft.time}`
    case 'weekdays':
      return `Weekdays at ${draft.time}`
    case 'week':
      return `${WEEKDAYS[draft.weekday]} at ${draft.time}`
    case 'month':
      return `The ${ordinal(draft.monthDay)} of every month at ${draft.time}`
    default:
      return text.trim()
  }
}

/** The browser's own zone, sent as `timezone` when a schedule is set. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** "Fri 14 Nov, 16:00" in the schedule's own zone; a zone the browser doesn't know falls back to its own. */
export function whenText(iso: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }
  const date = new Date(iso)
  let text: string
  try {
    text = new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).format(date)
  } catch {
    text = new Intl.DateTimeFormat('en-GB', options).format(date)
  }
  // en-GB reads "Fri 14 Nov, 16:00" or "Fri, 14 Nov, 16:00" by engine; one form.
  return text.replace(/^(\w{3}),/, '$1').replace(/ at /, ', ')
}
