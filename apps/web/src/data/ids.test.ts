import { expect, test, vi } from 'vitest'
import { newId } from './ids.ts'

test('newId makes RFC 4122 v4 ids without crypto.randomUUID (plain-HTTP origins)', () => {
  vi.stubGlobal('crypto', {
    getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
  })
  const ids = new Set(Array.from({ length: 200 }, () => newId()))
  expect(ids.size).toBe(200)
  for (const id of ids)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  vi.unstubAllGlobals()
})
