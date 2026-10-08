import { expect, test } from 'vitest'
import { loadConfig, serverOrigin } from '../src/config.ts'

const remote = {
  SCORE_REMOTE: '1',
  SCORE_HOST: '192.168.1.2',
  SCORE_PUBLIC_ORIGINS: 'http://score.lan:8741',
  SCORE_REMOTE_INSECURE_HTTP: 'accept',
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
test('HTTP remote mode requires explicit acceptance, independently of interface', () => {
  expect(() => loadConfig({ ...remote, SCORE_REMOTE_INSECURE_HTTP: undefined })).toThrow(
    /requires SCORE_REMOTE_INSECURE_HTTP=accept/,
  )
  const config = loadConfig(remote)
  expect(config.port).toBe(8741)
  expect(config.remote?.bridgePort).toBe(8740)
  expect(serverOrigin(config)).toBe('http://score.lan:8741')
})
test('TLS public origins are independent of the numeric bind address', () => {
  const config = loadConfig({
    ...remote,
    SCORE_TLS_CERT: '/tmp/cert.pem',
    SCORE_TLS_KEY: '/tmp/key.pem',
    SCORE_REMOTE_INSECURE_HTTP: undefined,
    SCORE_PUBLIC_ORIGINS: 'https://score.example, https://[2001:db8::2]:9443/',
  })
  expect(config.remote?.origins).toEqual(['https://score.example', 'https://[2001:db8::2]:9443'])
  expect(serverOrigin(config)).toBe('https://score.example')
})
test.each([
  { SCORE_REMOTE: 'yes' },
  { SCORE_REMOTE_ANY: 'yes' },
  { SCORE_REMOTE_INSECURE_HTTP: 'yes' },
  { SCORE_HOST: 'score.lan' },
  { SCORE_PUBLIC_ORIGINS: '' },
  { SCORE_PUBLIC_ORIGINS: 'http://user:pass@score.lan' },
  { SCORE_PUBLIC_ORIGINS: 'http://score.lan/path' },
  { SCORE_PUBLIC_ORIGINS: 'https://score.lan' },
  { SCORE_TLS_CERT: '/tmp/cert' },
  { SCORE_TLS_KEY: '/tmp/key' },
  { SCORE_BRIDGE_PORT: '8741' },
  { SCORE_TLS_CERT: '/tmp/cert', SCORE_TLS_KEY: '/tmp/key' },
])('rejects invalid remote configuration %j', (env) =>
  expect(() => loadConfig({ ...remote, ...env })).toThrow(),
)
test('remote options cannot accidentally enable local exposure', () => {
  expect(() => loadConfig({ SCORE_PUBLIC_ORIGINS: 'http://score.lan' })).toThrow(
    /require SCORE_REMOTE/,
  )
})
