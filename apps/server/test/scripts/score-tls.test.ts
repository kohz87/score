import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const launcher = fileURLToPath(new URL('../../../../scripts/score', import.meta.url))
const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function tls(home: string, args: string[] = [], env: Record<string, string> = {}) {
  return execFileSync(launcher, ['tls', ...args], {
    env: { PATH: process.env.PATH!, HOME: home, SCORE_HOME: home, ...env },
    encoding: 'utf8',
  })
}
const mode = (path: string) => statSync(path).mode & 0o777
const x509 = (path: string) =>
  execFileSync('openssl', ['x509', '-in', path, '-noout', '-text'], { encoding: 'utf8' })
const fingerprint = (path: string) =>
  execFileSync('openssl', ['x509', '-in', path, '-noout', '-fingerprint', '-sha256'], {
    encoding: 'utf8',
  })

test('score tls creates a CA and a server certificate with the right names, modes and extensions', () => {
  const home = mkdtempSync(join(tmpdir(), 'score-tls-'))
  homes.push(home)
  const output = tls(home, [], {
    SCORE_HOST: '192.168.1.20',
    SCORE_PUBLIC_ORIGINS: 'https://score.lan:8741',
  })
  const dir = join(home, 'tls')
  expect(output).toContain(dir)
  expect(mode(dir)).toBe(0o700)
  expect(mode(join(dir, 'ca.key'))).toBe(0o600)
  expect(mode(join(dir, 'server.key'))).toBe(0o600)

  const ca = x509(join(dir, 'ca.crt'))
  expect(ca).toMatch(/Subject: CN\s*=\s*Score local CA \(/)
  expect(ca).toContain('CA:TRUE')
  expect(ca).toMatch(/Certificate Sign, CRL Sign/)
  expect(ca).toMatch(/Not After : /)

  const server = x509(join(dir, 'server.crt'))
  expect(server).toContain('IP Address:192.168.1.20')
  expect(server).toContain('DNS:score.lan')
  expect(server).toContain('DNS:localhost')
  expect(server).toContain('IP Address:127.0.0.1')
  expect(server).toContain('TLS Web Server Authentication')
  expect(server).toContain('CA:FALSE')
  const days =
    (Date.parse(/Not After : (.*)/.exec(server)![1]!) -
      Date.parse(/Not Before: (.*)/.exec(server)![1]!)) /
    86_400_000
  expect(Math.round(days)).toBe(825)
  execFileSync('openssl', ['verify', '-CAfile', join(dir, 'ca.crt'), join(dir, 'server.crt')])
  // The public file really is only a certificate.
  expect(readFileSync(join(dir, 'ca.crt'), 'utf8')).not.toContain('PRIVATE KEY')
})

test('a second run keeps the CA and re-issues the server certificate; --new-ca replaces both', () => {
  const home = mkdtempSync(join(tmpdir(), 'score-tls-'))
  homes.push(home)
  const dir = join(home, 'tls')
  tls(home, [], { SCORE_HOST: '10.0.0.5' })
  const ca = fingerprint(join(dir, 'ca.crt'))
  const server = fingerprint(join(dir, 'server.crt'))
  tls(home, [], { SCORE_HOST: '10.0.0.6' })
  expect(fingerprint(join(dir, 'ca.crt'))).toBe(ca)
  expect(fingerprint(join(dir, 'server.crt'))).not.toBe(server)
  expect(x509(join(dir, 'server.crt'))).toContain('IP Address:10.0.0.6')
  execFileSync('openssl', ['verify', '-CAfile', join(dir, 'ca.crt'), join(dir, 'server.crt')])
  tls(home, ['--new-ca'], { SCORE_HOST: '10.0.0.6' })
  expect(fingerprint(join(dir, 'ca.crt'))).not.toBe(ca)
  execFileSync('openssl', ['verify', '-CAfile', join(dir, 'ca.crt'), join(dir, 'server.crt')])
  expect(mode(join(dir, 'ca.key'))).toBe(0o600)
})

test('score tls with an unknown option fails and writes nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'score-tls-'))
  homes.push(home)
  expect(() => tls(home, ['--bogus'])).toThrow()
  expect(existsSync(join(home, 'tls', 'server.crt'))).toBe(false)
})

test('named certificates are enabled even when every name is already a listed origin', () => {
  const home = mkdtempSync(join(tmpdir(), 'score-tls-'))
  homes.push(home)
  const dir = join(home, 'tls', 'tailscale')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'box.tail1234.ts.net.crt'), 'x')
  writeFileSync(join(dir, 'box.tail1234.ts.net.key'), 'x')
  // The launcher without its command dispatch, so use_named_tls can run on its own.
  const body = readFileSync(launcher, 'utf8').split('\ncase "${1:-}" in')[0]!
  const harness = join(home, 'harness.sh')
  writeFileSync(
    harness,
    `${body}\nuse_named_tls\nprintf '%s|%s' "\${SCORE_TLS_NAMES_DIR:-UNSET}" "$SCORE_PUBLIC_ORIGINS"`,
  )
  const out = execFileSync('bash', [harness], {
    env: {
      PATH: process.env.PATH!,
      HOME: home,
      SCORE_HOME: home,
      SCORE_REMOTE: '1',
      SCORE_TLS_CERT: '/x',
      SCORE_PORT: '8741',
      SCORE_PUBLIC_ORIGINS: 'https://192.168.1.2:8741,https://box.tail1234.ts.net:8741',
    },
    encoding: 'utf8',
  })
  expect(out).toBe(`${dir}|https://192.168.1.2:8741,https://box.tail1234.ts.net:8741`)
})
