import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, connect, type TLSSocket } from 'node:tls'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { certificateNames, namedCertificates } from '../src/tls-names.ts'
import { namedCert, namedKey, testCert, testKey } from './fixtures/tls.ts'

const NAME = 'score-named.example.ts.net'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-tls-names-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('only well-formed names with both files count as certificates', () => {
  writeFileSync(join(dir, `${NAME}.crt`), namedCert)
  writeFileSync(join(dir, `${NAME}.key`), namedKey)
  writeFileSync(join(dir, 'lonely.example.net.crt'), namedCert)
  writeFileSync(join(dir, '..bad.crt'), namedCert)
  writeFileSync(join(dir, '..bad.key'), namedKey)
  expect(certificateNames(dir)).toEqual([NAME])
  expect(certificateNames(join(dir, 'missing'))).toEqual([])
})

test('a browser asking for the name gets its certificate; an address or unknown name gets the default', async () => {
  writeFileSync(join(dir, `${NAME}.crt`), namedCert)
  writeFileSync(join(dir, `${NAME}.key`), namedKey)
  const server = createServer({
    cert: testCert,
    key: testKey,
    SNICallback: namedCertificates(dir).sniCallback,
  })
  server.on('secureConnection', (socket) => socket.end())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const subjectFor = (servername?: string) =>
    new Promise<string>((resolve, reject) => {
      const socket: TLSSocket = connect({
        host: '127.0.0.1',
        port,
        rejectUnauthorized: false,
        ...(servername ? { servername } : {}),
      })
      socket.once('secureConnect', () => {
        resolve(String(socket.getPeerCertificate().subject.CN))
        socket.destroy()
      })
      socket.once('error', reject)
    })
  try {
    expect(await subjectFor(NAME)).toBe(NAME)
    expect(await subjectFor('other.example.net')).toBe('localhost')
    expect(await subjectFor()).toBe('localhost')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('renewed files are picked up after the recheck interval; broken files keep the last good one', () => {
  let now = 0
  writeFileSync(join(dir, `${NAME}.crt`), namedCert)
  writeFileSync(join(dir, `${NAME}.key`), namedKey)
  const names = namedCertificates(dir, () => now)
  const first = names.contextFor(NAME)
  expect(first).toBeDefined()
  writeFileSync(join(dir, `${NAME}.crt`), `${namedCert}\n`)
  expect(names.contextFor(NAME)).toBe(first)
  now += 61_000
  const renewed = names.contextFor(NAME)
  expect(renewed).toBeDefined()
  expect(renewed).not.toBe(first)
  writeFileSync(join(dir, `${NAME}.key`), 'not a key')
  now += 61_000
  expect(names.contextFor(NAME)).toBe(renewed)
  expect(names.contextFor('UPPER..bad')).toBeUndefined()
})
