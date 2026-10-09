import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { inspectProfileArchive, readModel } from '../../src/hermes/archive-inspect.ts'
import { sampleProfile, tarBytes, tarGz, type TarEntry } from '../helpers/tar.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-inspect-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
async function inspect(bytes: Buffer) {
  const path = join(dir, 'a.tar.gz')
  writeFileSync(path, bytes)
  return inspectProfileArchive(path, 200 * 1024 * 1024)
}
const refused = (entries: TarEntry[]) =>
  expect(inspect(tarGz(entries))).rejects.toMatchObject({ status: 400 })

test('reads name, model, skills, plugins, memory size and config version without extracting', async () => {
  const facts = await inspect(sampleProfile())
  expect(facts).toMatchObject({
    root: 'scout',
    description: 'Reads and summarizes',
    model: 'example/model-1',
    configVersion: '31',
    skills: ['research/web'],
    plugins: ['notes'],
    memoryBytes: 1234,
    credentialFiles: [],
    hasBridge: false,
  })
  expect(facts.warnings.join(' ')).toContain('run code')
})

test('flags credential files by path and never reads their content', async () => {
  const facts = await inspect(
    sampleProfile('scout', [
      { name: 'scout/.env', body: 'TOKEN=sk-supersecretvalue123456' },
      { name: 'scout/auth.json', body: '{"k":"v"}' },
      { name: 'scout/.env.example', body: 'X=' },
    ]),
  )
  expect(facts.credentialFiles).toEqual(['.env', 'auth.json'])
  expect(JSON.stringify(facts)).not.toContain('supersecret')
  expect(facts.warnings.join(' ')).toContain('credential')
})

test('detects an installed bridge plugin and long names', async () => {
  const long = `scout/skills/${'deep/'.repeat(30)}SKILL.md`
  const facts = await inspect(
    sampleProfile('scout', [
      { name: 'scout/plugins/score-bridge/plugin.yaml', body: 'name: score-bridge' },
      { name: long, body: 'x' },
    ]),
  )
  expect(facts.hasBridge).toBe(true)
  expect(facts.skills.some((name) => name.startsWith('deep/'))).toBe(true)
})

test.each([
  ['parent traversal', [{ name: 'scout/' }, { name: 'scout/../../etc/passwd', body: 'x' }]],
  ['absolute path', [{ name: '/etc/passwd', body: 'x' }]],
  ['windows drive', [{ name: 'C:/x/y', body: 'x' }]],
  ['backslash traversal', [{ name: 'scout/..\\..\\x', body: 'x' }]],
  ['symlink', [{ name: 'scout/' }, { name: 'scout/l', type: '2', link: '/etc/passwd' }]],
  ['hardlink', [{ name: 'scout/' }, { name: 'scout/l', type: '1', link: 'scout/a' }]],
  ['device', [{ name: 'scout/' }, { name: 'scout/d', type: '3' }]],
  ['two roots', [{ name: 'a/' }, { name: 'a/x', body: 'x' }, { name: 'b/y', body: 'y' }]],
  ['top-level file', [{ name: 'loose.txt', body: 'x' }]],
  ['empty archive', []],
] as [string, TarEntry[]][])('refuses %s', async (_label, entries) => {
  await refused(entries)
})

test('refuses non-gzip input, corrupt headers and truncated archives', async () => {
  await expect(inspect(Buffer.from('not an archive'))).rejects.toMatchObject({ status: 400 })
  const raw = tarBytes([{ name: 'scout/' }, { name: 'scout/a', body: 'hello' }])
  raw[10] = raw[10]! ^ 0xff // header byte changed after the checksum was computed
  await expect(inspect(gzipSync(raw))).rejects.toMatchObject({ status: 400 })
  const good = tarBytes([{ name: 'scout/' }, { name: 'scout/a', body: 'hello' }])
  await expect(inspect(gzipSync(good.subarray(0, 700)))).rejects.toMatchObject({ status: 400 })
})

test('refuses too many entries and a decompression bomb', async () => {
  const many: TarEntry[] = [{ name: 'scout/' }]
  for (let i = 0; i < 50_001; i++) many.push({ name: `scout/f${i}`, body: '' })
  await refused(many)
  // 40 MiB of zeros in one file gzips to ~40 KiB: far past the ratio bound.
  await refused([{ name: 'scout/' }, { name: 'scout/zeros', body: Buffer.alloc(40 * 1024 * 1024) }])
})

test('refuses a file over the size limit', async () => {
  const path = join(dir, 'big.tar.gz')
  writeFileSync(path, sampleProfile())
  await expect(inspectProfileArchive(path, 10)).rejects.toMatchObject({ status: 400 })
})

test('model field reading handles inline and nested forms', () => {
  expect(readModel('model: "a/b"  # note\n')).toBe('a/b')
  expect(readModel('x: 1\nmodel:\n  provider: p\n  default: m\nother: 2\n')).toBe('m')
  expect(readModel('other:\n  default: no\n')).toBeNull()
})
