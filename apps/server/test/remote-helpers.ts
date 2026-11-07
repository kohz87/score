import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, expect, vi } from 'vitest'
import { buildApp } from '../src/app.ts'
import { SecurityPassword } from '../src/auth/security-password.ts'
import { loadConfig } from '../src/config.ts'
import { testCert, testKey } from './fixtures/tls.ts'

export const origin = 'https://score.lan:8741'
export const headers = { host: 'score.lan:8741', origin, 'x-score-client': 'web' }
export const env = {
  SCORE_REMOTE: '1',
  SCORE_TLS_CERT: '/tmp/cert',
  SCORE_TLS_KEY: '/tmp/key',
  SCORE_PUBLIC_ORIGINS: origin,
}

export const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.useRealTimers()
})

export function makeApp(clock?: () => number, extraEnv: Record<string, string> = {}) {
  const config = loadConfig({ ...env, ...extraEnv })
  const securityHome = mkdtempSync(join(tmpdir(), 'score-security-'))
  cleanup.push(() => rmSync(securityHome, { recursive: true, force: true }))
  const app = buildApp({
    config,
    clock,
    logger: false,
    security: new SecurityPassword(securityHome, clock),
  })
  cleanup.push(() => app.close())
  return app
}
// Env for tests that really start the server: it reads the certificate files.
export function tlsEnv(dir: string) {
  writeFileSync(join(dir, 'cert.pem'), testCert)
  writeFileSync(join(dir, 'key.pem'), testKey)
  return {
    ...env,
    SCORE_HOME: join(dir, 'home'),
    SCORE_TLS_CERT: join(dir, 'cert.pem'),
    SCORE_TLS_KEY: join(dir, 'key.pem'),
  }
}
export const PASSWORD = 'correct horse battery'
export async function setPassword(app: FastifyInstance, cookie: string) {
  const response = await app.inject({
    method: 'PUT',
    url: '/api/session/security/password',
    headers: { ...headers, cookie },
    payload: { password: PASSWORD },
  })
  expect(response.statusCode).toBe(204)
  // Setting the first password unlocks the section (3.14.2); lock it so each test proves what the password guards.
  await app.inject({
    method: 'POST',
    url: '/api/session/security/lock',
    headers: { ...headers, cookie },
  })
}
export async function unlock(app: FastifyInstance, cookie: string, password = PASSWORD) {
  return app.inject({
    method: 'POST',
    url: '/api/session/security/unlock',
    headers: { ...headers, cookie },
    payload: { password },
  })
}
export async function pair(app: FastifyInstance, origin = headers.origin) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { ...headers, origin },
    payload: { token: app.pairing.createToken() },
  })
  expect(response.statusCode).toBe(204)
  return String(response.headers['set-cookie']).split(';')[0]!
}
export function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'score-remote-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
