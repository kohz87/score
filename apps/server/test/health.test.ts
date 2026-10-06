import { expect, test } from 'vitest'
import { CONTRACT_VERSION } from '@score/contract'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'

test('GET /api/health', async () => {
  const app = buildApp({ config: loadConfig({}), logger: false })
  const res = await app.inject({ method: 'GET', url: '/api/health' })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ ok: true, contract: CONTRACT_VERSION })
  await app.close()
})
