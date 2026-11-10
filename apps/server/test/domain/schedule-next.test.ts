import { expect, test } from 'vitest'
import { nextFire, parseSchedule } from '../../src/domain/schedule-next.ts'

const at = (iso: string) => new Date(iso)

test('every day at 08:00 in Singapore fires at 00:00 UTC, the next day once it has passed', () => {
  expect(nextFire('0 8 * * *', 'Asia/Singapore', at('2026-11-10T09:00:00Z'))?.toISOString()).toBe(
    '2026-11-11T00:00:00.000Z',
  )
  expect(nextFire('0 8 * * *', 'Asia/Singapore', at('2026-11-10T23:59:00Z'))?.toISOString()).toBe(
    '2026-11-11T00:00:00.000Z',
  )
})

test('weekdays skip the weekend; a weekly day; a monthly day', () => {
  // Friday 14 Nov 2026, 17:00 UTC: the next weekday 09:00 UTC is Monday 17 Nov.
  expect(nextFire('0 9 * * 1-5', 'UTC', at('2026-11-14T17:00:00Z'))?.toISOString()).toBe(
    '2026-11-16T09:00:00.000Z',
  )
  expect(nextFire('0 16 * * 5', 'UTC', at('2026-11-10T00:00:00Z'))?.toISOString()).toBe(
    '2026-11-13T16:00:00.000Z',
  )
  expect(nextFire('30 7 1 * *', 'UTC', at('2026-11-10T00:00:00Z'))?.toISOString()).toBe(
    '2026-12-01T07:30:00.000Z',
  )
})

test('a daylight-saving zone keeps the wall-clock time across the change', () => {
  // New York leaves summer time on 1 Nov 2026: 08:00 is 12:00 UTC before, 13:00 UTC after.
  expect(nextFire('0 8 * * *', 'America/New_York', at('2026-10-30T13:00:00Z'))?.toISOString()).toBe(
    '2026-10-31T12:00:00.000Z',
  )
  expect(nextFire('0 8 * * *', 'America/New_York', at('2026-11-01T00:00:00Z'))?.toISOString()).toBe(
    '2026-11-01T13:00:00.000Z',
  )
})

test('every n counts from the anchor; steps, lists and 7 for Sunday', () => {
  expect(
    nextFire(
      'every 2h',
      'UTC',
      at('2026-11-10T05:30:00Z'),
      at('2026-11-10T00:00:00Z'),
    )?.toISOString(),
  ).toBe('2026-11-10T06:00:00.000Z')
  expect(nextFire('*/15 * * * *', 'UTC', at('2026-11-10T05:31:00Z'))?.toISOString()).toBe(
    '2026-11-10T05:45:00.000Z',
  )
  expect(nextFire('0 10 * * 7', 'UTC', at('2026-11-10T00:00:00Z'))?.toISOString()).toBe(
    '2026-11-15T10:00:00.000Z',
  )
})

test('what it can’t read, or what never fires, has no next time', () => {
  expect(parseSchedule('tomorrow')).toBeNull()
  expect(parseSchedule('61 * * * *')).toBeNull()
  expect(nextFire('0 0 31 2 *', 'UTC', at('2026-11-10T00:00:00Z'))).toBeNull()
})
