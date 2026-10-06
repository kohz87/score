import { createHash } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { PairingService } from '../src/auth/pairing.ts'
import { InMemorySessionStore } from '../src/auth/session-store.ts'

test('only a sha256 session hash reaches the SessionStore', () => {
  const store = new InMemorySessionStore()
  const create = vi.spyOn(store, 'create')
  const pairing = new PairingService(store, () => 1000)
  const token = pairing.createToken()
  expect(create).not.toHaveBeenCalled()
  const id = pairing.pair(token)
  expect(create).toHaveBeenCalledExactlyOnceWith(
    createHash('sha256').update(id).digest('hex'),
    1000 + 2592000 * 1000,
  )
  expect(store.has(id, 1000)).toBe(false)
  expect(store.has(token, 1000)).toBe(false)
  expect(pairing.isPaired(`score_session=${token}`)).toBe(false)
  expect(pairing.isPaired(`score_session=${id}`)).toBe(true)
})
