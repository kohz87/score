import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import {
  DAY,
  createSharesHelpers,
  sharesTestSuite,
  type SharesTestState,
} from './shares-helpers.ts'

let dir: SharesTestState['dir']
let db: SharesTestState['db']
let scheduler: SharesTestState['scheduler']
let app: SharesTestState['app']
let state: SharesTestState
const current = (): SharesTestState => state
sharesTestSuite((next) => {
  state = next
  dir = next.dir
  db = next.db
  scheduler = next.scheduler
  app = next.app
}, current)

const { setPassword, room, say, create, tokenOf, page } = createSharesHelpers(current)

test('creating a share needs a paired browser and the security password, with its limits', async () => {
  const r = await room()
  expect((await create(r.id, {}, { 'x-score-client': 'web', cookie: '' })).statusCode).toBe(401)
  // No password set yet.
  const unset = await create(r.id)
  expect(unset.statusCode).toBe(409)
  expect(unset.json().error.code).toBe('password_not_set')
  await setPassword()
  const wrong = await create(r.id, { password: 'not the password' })
  expect(wrong.statusCode).toBe(403)
  expect(wrong.json().error.code).toBe('wrong_password')
  expect((await create(r.id, { password: undefined })).statusCode).toBe(403)
  for (let i = 0; i < 2; i++) await create(r.id, { password: 'still wrong' })
  expect((await create(r.id, { password: 'still wrong' })).statusCode).toBe(403)
  const locked = await create(r.id)
  expect(locked.statusCode).toBe(429)
  expect(locked.json().error.code).toBe('too_many_attempts')
  expect((await app.inject({ url: '/api/shares' })).statusCode).toBe(401)
})

test('validates expiry and room; defaults to 7 days', async () => {
  await setPassword()
  const r = await room()
  expect((await create(r.id, { expiresInDays: 0 })).statusCode).toBe(400)
  expect((await create(r.id, { expiresInDays: 31 })).statusCode).toBe(400)
  expect((await create(r.id, { stray: true })).statusCode).toBe(400)
  expect((await create('nope')).statusCode).toBe(404)
  const made = (await create(r.id)).json()
  expect(Date.parse(made.expiresAt) - scheduler.now()).toBe(7 * DAY)
  expect(made.url).toMatch(/^http:\/\/[^/]+\/s\/[A-Za-z0-9_-]{43}$/)
  const long = (await create(r.id, { expiresInDays: 30 })).json()
  expect(Date.parse(long.expiresAt) - scheduler.now()).toBe(30 * DAY)
})

test('the token is never stored in clear: only its SHA-256, and lookup goes by hash', async () => {
  await setPassword()
  const r = await room()
  await say(r.id, [{ kind: 'text', text: 'hello from the share' }])
  const made = (await create(r.id)).json()
  const token = tokenOf(made.url)
  const rows = db.sqlite.prepare('SELECT * FROM room_shares').all()
  expect(rows).toHaveLength(1)
  expect(JSON.stringify(rows)).not.toContain(token)
  expect(rows[0]!.token_hash).toBe(createHash('sha256').update(token).digest('hex'))
  expect(rows[0]!.id).toBe(made.id)
  // Not in the database file's pages either (WAL included).
  db.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  expect(readFileSync(join(dir, 'score.db')).includes(Buffer.from(token))).toBe(false)
  // The hash is not a token.
  expect((await page(rows[0]!.token_hash as string)).statusCode).toBe(404)
  const ok = await page(token)
  expect(ok.statusCode).toBe(200)
  expect(ok.body).toContain('hello from the share')
})
