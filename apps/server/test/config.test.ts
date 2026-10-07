import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ZodError } from 'zod'
import { loadConfig, serverOrigin } from '../src/config.ts'

test('loads defaults without reading process.env', () => {
  expect(loadConfig({})).toEqual({
    home: join(homedir(), '.score'),
    host: '127.0.0.1',
    port: 8740,
    webOrigin: 'http://127.0.0.1:5173',
    mode: 'fake',
    fakeSpeed: 1,
    fakeLoop: true,
  })
})

test('loads explicit config and normalizes the web origin', () => {
  const env = {
    SCORE_HOME: '/tmp/score-test',
    SCORE_HERMES_HOME: '/tmp/hermes-test',
    SCORE_HOST: 'localhost',
    SCORE_PORT: '9000',
    SCORE_WEB_ORIGIN: 'https://localhost:5173/',
    SCORE_MODE: 'live',
    SCORE_FAKE_SPEED: '2.5',
    SCORE_FAKE_LOOP: 'false',
  }
  expect(loadConfig(env)).toEqual({
    home: '/tmp/score-test',
    hermesHome: '/tmp/hermes-test',
    host: 'localhost',
    port: 9000,
    webOrigin: 'https://localhost:5173',
    mode: 'live',
    fakeSpeed: 2.5,
    fakeLoop: false,
  })
  expect(env.SCORE_WEB_ORIGIN).toBe('https://localhost:5173/')
})

test.each([
  { SCORE_PORT: '0' },
  { SCORE_PORT: '65536' },
  { SCORE_PORT: '8740.5' },
  { SCORE_PORT: 'invalid' },
  { SCORE_MODE: 'unknown' },
  { SCORE_FAKE_LOOP: 'yes' },
  { SCORE_FAKE_LOOP: '' },
  { SCORE_FAKE_SPEED: '0' },
  { SCORE_FAKE_SPEED: '-1' },
  { SCORE_FAKE_SPEED: 'NaN' },
  { SCORE_FAKE_SPEED: 'Infinity' },
  { SCORE_FAKE_SPEED: '' },
  { SCORE_HOME: '' },
  { SCORE_HERMES_HOME: '' },
  { SCORE_HOST: 'localhost/path' },
  { SCORE_WEB_ORIGIN: 'file:///tmp/score' },
  { SCORE_WEB_ORIGIN: 'http://localhost:5173/pair' },
  { SCORE_WEB_ORIGIN: 'http://user:password@localhost:5173' },
  { SCORE_WEB_ORIGIN: 'http://localhost:5173?token=secret' },
  { SCORE_WEB_ORIGIN: 'not-a-url' },
])('rejects invalid config %j', (env) => {
  expect(() => loadConfig(env)).toThrow(ZodError)
})

test('constructs IPv6 and default server origins', () => {
  expect(serverOrigin(loadConfig({}))).toBe('http://127.0.0.1:8740')
  expect(serverOrigin(loadConfig({ SCORE_HOST: '::1' }))).toBe('http://[::1]:8740')
})
