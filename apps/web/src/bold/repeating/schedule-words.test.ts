import { expect, test } from 'vitest'
import {
  buildSchedule,
  nextWords,
  parseSchedule,
  previewNext,
  scheduleWords,
} from './schedule-words.ts'

// Local-time dates, because the words are in the person's zone. Wed 11 Nov 2026, 10:00.
const now = new Date(2026, 10, 11, 10, 0)

test('the shapes the panel makes are said in words', () => {
  expect(scheduleWords('0 8 * * *')).toBe('Every day, 08:00')
  expect(scheduleWords('30 9 * * 1-5')).toBe('Weekdays, 09:30')
  expect(scheduleWords('0 9 * * 1')).toBe('Mondays, 09:00')
  expect(scheduleWords('0 17 * * 5')).toBe('Fridays, 17:00')
  expect(scheduleWords('0 8 1 * *')).toBe('1st of the month, 08:00')
  expect(scheduleWords('0 8 22 * *')).toBe('22nd of the month, 08:00')
  expect(scheduleWords('0 8 13 * *')).toBe('13th of the month, 08:00')
  expect(scheduleWords('every 2h')).toBe('Every 2 hours')
  expect(scheduleWords('every 1d')).toBe('Every day')
  expect(scheduleWords('every 30m')).toBe('Every 30 minutes')
})

test('anything else is shown as typed', () => {
  for (const text of ['*/5 * * * *', '0 8 * 6 *', '0 8 29 * *', '0 8,12 * * *', '0 8 * * 1-3'])
    expect(scheduleWords(text)).toBe(text)
})

test('parse and build round-trip the panel shapes', () => {
  for (const text of ['0 8 * * *', '15 17 * * 1-5', '0 9 * * 0', '0 8 28 * *']) {
    const parsed = parseSchedule(text)
    expect(parsed.kind).not.toBe('custom')
    expect(buildSchedule(parsed.kind, parsed.time, parsed.day, '')).toBe(text)
  }
  expect(parseSchedule('every 2h').kind).toBe('custom')
  expect(buildSchedule('custom', '', 1, '  every 2h ')).toBe('every 2h')
  expect(buildSchedule('daily', '25:00', 1, '')).toBeNull()
})

test('next is in hours, minutes, or a day', () => {
  expect(nextWords(null, now)).toBeNull()
  expect(nextWords(new Date(2026, 10, 11, 10, 5).toISOString(), now)).toBe('next in 5 min')
  expect(nextWords(new Date(2026, 10, 12, 0, 0).toISOString(), now)).toBe('next in 14 h')
  expect(nextWords(new Date(2026, 10, 13, 17, 0).toISOString(), now)).toBe('next Fri 17:00')
  expect(nextWords(new Date(2026, 11, 1, 8, 0).toISOString(), now)).toBe('next Dec 1 08:00')
})

test('the panel previews the next fire for the timed shapes only', () => {
  expect(previewNext('daily', '08:00', 1, now)).toBe('tomorrow 08:00')
  expect(previewNext('daily', '11:00', 1, now)).toBe('today 11:00')
  expect(previewNext('weekdays', '08:00', 1, new Date(2026, 10, 13, 10, 0))).toBe('Mon 08:00')
  expect(previewNext('weekly', '09:00', 1, now)).toBe('Mon 09:00')
  expect(previewNext('monthly', '08:00', 1, now)).toBe('Dec 1 08:00')
  expect(previewNext('custom', '08:00', 1, now)).toBeNull()
  expect(previewNext('daily', 'late', 1, now)).toBeNull()
})
