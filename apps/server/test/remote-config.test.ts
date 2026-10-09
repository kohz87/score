import { expect, test } from 'vitest'
import { guideOnly, loadConfig, serverOrigin } from '../src/config.ts'

const remote = {
  SCORE_REMOTE: '1',
  SCORE_HOST: '192.168.1.2',
  SCORE_PUBLIC_ORIGINS: 'https://score.lan:8741',
  SCORE_TLS_CERT: '/tmp/cert.pem',
  SCORE_TLS_KEY: '/tmp/key.pem',
}

test.each(['192.168.1.2', '0.0.0.0', '::', '2001:db8::1', 'score.lan'])(
  'local mode refuses non-loopback %s',
  (host) => {
    expect(() => loadConfig({ SCORE_HOST: host })).toThrow(/requires SCORE_REMOTE/)
  },
)
test.each(['127.0.0.1', '127.0.0.2', '::1', 'localhost'])(
  'local mode accepts loopback %s',
  (host) => {
    expect(loadConfig({ SCORE_HOST: host }).host).toBe(host)
  },
)
test.each(['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0'])(
  'remote wildcard %s requires opt-in',
  (host) => {
    expect(() => loadConfig({ ...remote, SCORE_HOST: host })).toThrow(/SCORE_REMOTE_ANY/)
    expect(loadConfig({ ...remote, SCORE_HOST: host, SCORE_REMOTE_ANY: '1' }).remote).toBeDefined()
  },
)

test('expanded and IPv4-mapped loopback addresses stay local', () => {
  expect(loadConfig({ SCORE_HOST: '0:0:0:0:0:0:0:1' }).host).toBe('::1')
  expect(loadConfig({ SCORE_HOST: '::ffff:127.0.0.1' }).host).toBe('::ffff:7f00:1')
  expect(() => loadConfig({ SCORE_HOST: '::ffff:192.168.1.2' })).toThrow(/requires SCORE_REMOTE/)
})
test('remote mode with a certificate serves normally; without one it is guide-only', () => {
  const config = loadConfig(remote)
  expect(config.port).toBe(8741)
  expect(config.remote?.bridgePort).toBe(8740)
  expect(serverOrigin(config)).toBe('https://score.lan:8741')
  expect(guideOnly(config)).toBe(false)
  const bare = loadConfig({
    ...remote,
    SCORE_TLS_CERT: undefined,
    SCORE_TLS_KEY: undefined,
  })
  expect(guideOnly(bare)).toBe(true)
  expect(guideOnly(loadConfig({}))).toBe(false)
})
test('SCORE_REMOTE_INSECURE_HTTP is removed: ignored, never enables plain HTTP', () => {
  const noTls = { ...remote, SCORE_TLS_CERT: undefined, SCORE_TLS_KEY: undefined }
  for (const value of ['accept', 'yes']) {
    const config = loadConfig({ ...noTls, SCORE_REMOTE_INSECURE_HTTP: value })
    expect(config.ignoredInsecureHttp).toBe(true)
    expect(guideOnly(config)).toBe(true)
  }
  expect(loadConfig(noTls).ignoredInsecureHttp).toBe(false)
  // Combined with a certificate it changes nothing either.
  expect(guideOnly(loadConfig({ ...remote, SCORE_REMOTE_INSECURE_HTTP: 'accept' }))).toBe(false)
})
test('TLS public origins are independent of the numeric bind address', () => {
  const config = loadConfig({
    ...remote,
    SCORE_PUBLIC_ORIGINS: 'https://score.example, https://[2001:db8::2]:9443/',
  })
  expect(config.remote?.origins).toEqual(['https://score.example', 'https://[2001:db8::2]:9443'])
  expect(serverOrigin(config)).toBe('https://score.example')
})
test.each([
  { SCORE_REMOTE: 'yes' },
  { SCORE_REMOTE_ANY: 'yes' },
  { SCORE_HOST: 'score.lan' },
  { SCORE_PUBLIC_ORIGINS: '' },
  { SCORE_PUBLIC_ORIGINS: 'https://user:pass@score.lan' },
  { SCORE_PUBLIC_ORIGINS: 'https://score.lan/path' },
  { SCORE_PUBLIC_ORIGINS: 'http://score.lan' },
  { SCORE_TLS_KEY: undefined },
  { SCORE_BRIDGE_PORT: '8741' },
])('rejects invalid remote configuration %j', (env) =>
  expect(() => loadConfig({ ...remote, ...env })).toThrow(),
)
test('remote options cannot accidentally enable local exposure', () => {
  expect(() => loadConfig({ SCORE_PUBLIC_ORIGINS: 'http://score.lan' })).toThrow(
    /require SCORE_REMOTE/,
  )
})
