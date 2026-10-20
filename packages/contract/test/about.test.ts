import { expect, test } from 'vitest'
import { AboutSchema, UpdateCheckSchema } from '../src/index.ts'

const about = {
  version: '1.3.0',
  commit: 'abc1234',
  schema: 67,
  contract: 1,
  hermes: { version: '0.9.0' },
  node: 'v24.0.0',
  mode: 'live',
  repository: 'https://github.com/kohz87/score',
  checkout: '/srv/score',
  service: false,
}

test('About accepts a checkout without git or Hermes, and rejects a plain-http repository', () => {
  expect(AboutSchema.parse({ ...about, commit: null, hermes: null }).commit).toBeNull()
  expect(AboutSchema.safeParse({ ...about, repository: 'http://example.com/x' }).success).toBe(
    false,
  )
})

test('UpdateCheck needs a status from the list and links only when there is a latest version', () => {
  const base = { checkedAt: '2026-10-14T10:00:00.000Z', current: '1.3.0', latest: null }
  expect(
    UpdateCheckSchema.parse({ ...base, status: 'unavailable', message: 'Couldn’t reach GitHub.' })
      .latest,
  ).toBeNull()
  expect(UpdateCheckSchema.safeParse({ ...base, status: 'newer', message: 'x' }).success).toBe(
    false,
  )
})
