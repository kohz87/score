import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AgentFileConflictError, etagOf } from '../../../src/hermes/agent-files.ts'
import { ProfileFiles } from '../../../src/hermes/live/profile-files.ts'
import { ProfilesReader } from '../../../src/hermes/live/profiles.ts'

let root: string
let home: string
const files = new ProfileFiles()
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'score-pfiles-'))
  home = join(root, 'profiles', 'builder')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(join(home, 'SOUL.md'), 'Be kind.\n', { mode: 0o640 })
  fs.writeFileSync(join(home, '.env'), 'planted-secret')
  fs.writeFileSync(join(home, 'auth.json'), 'planted-secret')
  fs.writeFileSync(join(home, 'config.yaml'), 'model: x\n')
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

test('read returns content and the sha256 etag; a missing file reads as empty', () => {
  const soul = files.read(home, 'SOUL.md')
  expect(soul).toEqual({ content: 'Be kind.\n', etag: etagOf('Be kind.\n') })
  expect(files.read(home, 'AGENTS.md')).toEqual({ content: '', etag: etagOf('') })
})
test('write with a matching etag replaces the file, keeps its mode and leaves no temp files', async () => {
  const { etag } = files.read(home, 'SOUL.md')
  const result = await files.write(home, 'SOUL.md', 'Be precise.\n', etag)
  expect(result.etag).toBe(etagOf('Be precise.\n'))
  expect(fs.readFileSync(join(home, 'SOUL.md'), 'utf8')).toBe('Be precise.\n')
  expect(fs.statSync(join(home, 'SOUL.md')).mode & 0o777).toBe(0o640)
  expect(fs.readdirSync(home).sort()).toEqual(['.env', 'SOUL.md', 'auth.json', 'config.yaml'])
})
test('creating a missing file uses the empty etag and mode 0644', async () => {
  await files.write(home, 'AGENTS.md', '# Rules\n', etagOf(''))
  expect(fs.readFileSync(join(home, 'AGENTS.md'), 'utf8')).toBe('# Rules\n')
  expect(fs.statSync(join(home, 'AGENTS.md')).mode & 0o777).toBe(0o644)
})
test('a stale etag conflicts and reports the current file without writing', async () => {
  const stale = files.read(home, 'SOUL.md').etag
  fs.writeFileSync(join(home, 'SOUL.md'), 'Changed outside.\n')
  const error = await files.write(home, 'SOUL.md', 'Mine.\n', stale).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(AgentFileConflictError)
  expect((error as AgentFileConflictError).current).toEqual({
    content: 'Changed outside.\n',
    etag: etagOf('Changed outside.\n'),
  })
  expect(fs.readFileSync(join(home, 'SOUL.md'), 'utf8')).toBe('Changed outside.\n')
})
test('a change between the first check and the rename is caught by the compare-and-swap', async () => {
  const { etag } = files.read(home, 'SOUL.md')
  const rename = vi.spyOn(fs, 'renameSync')
  const fsync = fs.fsyncSync
  let tampered = false
  vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    // The temp file's fsync happens after the first check and before the re-read.
    if (!tampered) {
      tampered = true
      fs.writeFileSync(join(home, 'SOUL.md'), 'Sneaky.\n')
    }
    fsync(fd)
  })
  await expect(files.write(home, 'SOUL.md', 'Mine.\n', etag)).rejects.toBeInstanceOf(
    AgentFileConflictError,
  )
  expect(rename).not.toHaveBeenCalled()
  expect(fs.readFileSync(join(home, 'SOUL.md'), 'utf8')).toBe('Sneaky.\n')
  expect(fs.readdirSync(home).filter((name) => name.endsWith('.tmp'))).toEqual([])
})
test('a failure between writing the temp file and the rename leaves the original intact', async () => {
  const { etag } = files.read(home, 'SOUL.md')
  vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw new Error('crash')
  })
  await expect(files.write(home, 'SOUL.md', 'Mine.\n', etag)).rejects.toThrow('crash')
  expect(fs.readFileSync(join(home, 'SOUL.md'), 'utf8')).toBe('Be kind.\n')
  expect(fs.readdirSync(home).filter((name) => name.endsWith('.tmp'))).toEqual([])
})
test('concurrent writes with the same etag: exactly one wins', async () => {
  const { etag } = files.read(home, 'SOUL.md')
  const results = await Promise.allSettled([
    files.write(home, 'SOUL.md', 'One.\n', etag),
    files.write(home, 'SOUL.md', 'Two.\n', etag),
  ])
  expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
})
test('symlinked files, directories and non-allowlisted names are refused', async () => {
  fs.rmSync(join(home, 'SOUL.md'))
  fs.symlinkSync(join(home, 'auth.json'), join(home, 'SOUL.md'))
  expect(() => files.read(home, 'SOUL.md')).toThrow(/linked/)
  await expect(files.write(home, 'SOUL.md', 'x', etagOf('planted-secret'))).rejects.toThrow(
    /linked/,
  )
  expect(fs.readFileSync(join(home, 'auth.json'), 'utf8')).toBe('planted-secret')
  const linkedDir = join(root, 'profiles', 'linked')
  fs.symlinkSync(home, linkedDir)
  expect(() => files.read(linkedDir, 'AGENTS.md')).toThrow(/linked/)
  expect(() => files.read(home, '../config.yaml' as never)).toThrow()
  expect(() => files.read(home, 'config.yaml' as never)).toThrow()
  expect(() => files.read(join(root, 'nope'), 'SOUL.md')).toThrow(/not found/i)
})
test('size, NUL and encoding limits', async () => {
  const { etag } = files.read(home, 'SOUL.md')
  await expect(files.write(home, 'SOUL.md', 'x'.repeat(256 * 1024 + 1), etag)).rejects.toThrow(
    /256 KB/,
  )
  await expect(files.write(home, 'SOUL.md', 'a\0b', etag)).rejects.toThrow(/NUL/)
  await expect(files.write(home, 'SOUL.md', 'bad\ud800', etag)).rejects.toThrow(/UTF-8/)
  await files.write(home, 'SOUL.md', 'x'.repeat(256 * 1024), etag)
  fs.writeFileSync(join(home, 'AGENTS.md'), Buffer.from([0xff, 0xfe, 0x41]))
  expect(() => files.read(home, 'AGENTS.md')).toThrow(/UTF-8/)
  fs.writeFileSync(join(home, 'AGENTS.md'), 'x'.repeat(256 * 1024 + 1))
  expect(() => files.read(home, 'AGENTS.md')).toThrow(/256 KB/)
})
test('fs spy: only SOUL.md / AGENTS.md (and their temp files) are ever opened, written or renamed', async () => {
  const touched: string[] = []
  const record = (path: unknown) => touched.push(basename(String(path)))
  const open = fs.openSync
  vi.spyOn(fs, 'openSync').mockImplementation(((path: fs.PathLike, ...rest: never[]) => {
    record(path)
    return (open as (...args: unknown[]) => number)(path, ...rest)
  }) as typeof fs.openSync)
  const rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    record(from)
    record(to)
    rename(from, to)
  })
  const readFile = vi.spyOn(fs, 'readFileSync')
  const writeFile = vi.spyOn(fs, 'writeFileSync')
  const readdir = vi.spyOn(fs, 'readdirSync')
  const reader = new ProfilesReader(root)
  const profileHome = reader.profileHome('builder')
  expect(profileHome).toBe(home)
  await files.write(profileHome!, 'SOUL.md', 'New.\n', files.read(profileHome!, 'SOUL.md').etag)
  await files.write(profileHome!, 'AGENTS.md', 'Rules.\n', etagOf(''))
  expect(touched.length).toBeGreaterThan(0)
  for (const name of touched)
    expect(name).toMatch(/^(\.?(SOUL|AGENTS)\.md(\.score-[0-9a-f]+\.tmp)?|builder)$/)
  expect(readFile).not.toHaveBeenCalled()
  expect(writeFile).not.toHaveBeenCalled()
  expect(readdir).not.toHaveBeenCalled()
  expect(fs.readFileSync(join(home, '.env'), 'utf8')).toBe('planted-secret')
})
