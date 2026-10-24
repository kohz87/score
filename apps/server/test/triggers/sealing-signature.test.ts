import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { loadSealingKey, sealer } from '../../src/auth/sealing.ts'
import { newWebhookSecret, signWebhook, verifyWebhook } from '../../src/domain/triggers/signature.ts'

// PLAN 11.1d: Score's own secrets sealed at rest; Standard Webhooks signatures.

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'score-seal-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

test('the sealing key is made once, owner-only, and loads the same afterwards', () => {
  const first = loadSealingKey(home)
  expect(first).toHaveLength(32)
  expect(statSync(join(home, 'sealing.key')).mode & 0o777).toBe(0o600)
  expect(loadSealingKey(home).equals(first)).toBe(true)
  chmodSync(join(home, 'sealing.key'), 0o644)
  expect(() => loadSealingKey(home)).toThrow(/owner-only/)
})

test('a sealed value opens only with the same key and context, and not when tampered or truncated', () => {
  const seal = sealer(loadSealingKey(home))
  const sealed = seal.seal('whsec_abc', 'trigger:trg_1')
  expect(sealed).not.toContain('whsec_abc')
  expect(seal.unseal(sealed, 'trigger:trg_1')).toBe('whsec_abc')
  expect(seal.unseal(sealed, 'trigger:trg_2')).toBeNull()
  const other = sealer(Buffer.alloc(32, 7))
  expect(other.unseal(sealed, 'trigger:trg_1')).toBeNull()
  const [v, iv, body, tag] = sealed.split('.')
  expect(seal.unseal([v, iv, body, tag!.slice(0, 8)].join('.'), 'trigger:trg_1')).toBeNull()
  const flipped = Buffer.from(body!, 'base64url')
  flipped[0]! ^= 1
  expect(seal.unseal([v, iv, flipped.toString('base64url'), tag].join('.'), 'trigger:trg_1')).toBeNull()
  expect(seal.unseal('garbage', 'trigger:trg_1')).toBeNull()
})

const now = 1_790_000_000
const body = JSON.stringify({ ticket: { id: 'TCK-142' } })

test('a correctly signed call within five minutes passes, from either end of the window', () => {
  const secret = newWebhookSecret()
  expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)
  for (const sent of [now, now - 300, now + 300]) {
    const signature = signWebhook(secret, 'msg_1', sent, body)
    expect(verifyWebhook(secret, { id: 'msg_1', timestamp: String(sent), signature }, body, now)).toEqual({ ok: true })
  }
})

test('stale, forged, altered or incomplete calls are refused', () => {
  const secret = newWebhookSecret()
  const signature = signWebhook(secret, 'msg_1', now, body)
  const check = (headers: Record<string, string | undefined>, payload = body) =>
    verifyWebhook(secret, headers, payload, now)
  expect(check({ id: 'msg_1', timestamp: String(now - 301), signature: signWebhook(secret, 'msg_1', now - 301, body) })).toEqual({ ok: false, reason: 'stale_timestamp' })
  expect(check({ id: 'msg_1', timestamp: String(now), signature: signWebhook(newWebhookSecret(), 'msg_1', now, body) })).toEqual({ ok: false, reason: 'bad_signature' })
  expect(check({ id: 'msg_1', timestamp: String(now), signature }, `${body} `)).toEqual({ ok: false, reason: 'bad_signature' })
  expect(check({ id: 'msg_2', timestamp: String(now), signature })).toEqual({ ok: false, reason: 'bad_signature' })
  expect(check({ id: 'msg_1', timestamp: String(now), signature: signature.replace('v1,', 'v2,') })).toEqual({ ok: false, reason: 'bad_signature' })
  expect(check({ id: 'msg_1', timestamp: 'soon', signature })).toEqual({ ok: false, reason: 'missing_headers' })
  expect(check({ timestamp: String(now), signature })).toEqual({ ok: false, reason: 'missing_headers' })
  // One valid entry among several is enough (rotation on the sender's side).
  expect(check({ id: 'msg_1', timestamp: String(now), signature: `v1,AAAA ${signature}` })).toEqual({ ok: true })
})
