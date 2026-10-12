import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  cpSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  confirmCopy,
  confirmMove,
  HOME_INSTALLATION_FILE,
  INSTALLATIONS_FILE,
  LAUNCHES_DIR,
  MANIFEST_FILE,
  readHomeInstallation,
  readRegistry,
  resolveInstallation,
  restoreMarkerDir,
} from '../src/installation.ts'
import { canonicalPath } from '../src/journal-location.ts'
import { ExecutionJournal } from '../src/domain/orchestration/journal.ts'

// 7.7a design v7 §2: installation identity, the registry outside the home, manifests, recovery, refusal on ambiguity,
// copied/moved-home detection.

let root: string
let journalDir: string
let home: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'score-inst-'))
  journalDir = join(root, 'journal')
  home = join(root, 'home')
  mkdirSync(home)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const resolveHome = (h = home) => resolveInstallation({ journalDir, home: h })
const okId = (result: ReturnType<typeof resolveHome>): string => {
  if (!result.ok) throw new Error(result.message)
  return result.id
}
const registryFile = () => join(journalDir, INSTALLATIONS_FILE)

test('a new installation writes the registry entry first, then the manifest, namespace, launches dir and the home copy', () => {
  let n = 0
  const result = resolveInstallation({ journalDir, home, mintId: () => `${'a'.repeat(15)}${n++}` })
  expect(result).toMatchObject({ ok: true, how: 'created', id: 'aaaaaaaaaaaaaaa0' })
  const id = okId(result)
  const registry = readRegistry(journalDir)
  expect(registry.state === 'ok' && registry.installations[id]!.paths).toMatchObject([
    { path: canonicalPath(home), state: 'current' },
  ])
  expect(JSON.parse(readFileSync(join(journalDir, id, MANIFEST_FILE), 'utf8'))).toMatchObject({
    id,
    paths: [canonicalPath(home)],
  })
  expect(existsSync(join(journalDir, id, LAUNCHES_DIR))).toBe(true)
  expect(readHomeInstallation(home)).toEqual({ state: 'ok', id })
  // The second start agrees with everything.
  expect(resolveHome()).toMatchObject({ ok: true, how: 'existing', id })
})

test('the registry entry exists before anything else names the id (crash right after the mint)', () => {
  // Simulate the crash: the mint wrote the registry and nothing else.
  const id = okId(resolveHome())
  rmSync(join(journalDir, id), { recursive: true })
  rmSync(join(home, HOME_INSTALLATION_FILE))
  // Next start: the path has an entry, so it recovers that id instead of minting a new one.
  expect(resolveHome()).toMatchObject({ ok: true, id, how: 'recovered' })
  expect(readdirSync(journalDir).filter((name) => /^[0-9a-f]{16}$/.test(name))).toEqual([id])
})

test('a home without its copy (a backup from before 7.7a, or a lost file) recovers the id from the registry by path', () => {
  const id = okId(resolveHome())
  rmSync(join(home, HOME_INSTALLATION_FILE))
  expect(resolveHome()).toMatchObject({ ok: true, id, how: 'recovered' })
  expect(readHomeInstallation(home)).toEqual({ state: 'ok', id })
})

test('a lost or corrupt registry is rebuilt from the manifests, never mistaken for a new path', () => {
  const id = okId(resolveHome())
  rmSync(registryFile())
  expect(resolveHome()).toMatchObject({ ok: true, id, how: 'recovered' })
  writeFileSync(registryFile(), '{ not json')
  expect(resolveHome()).toMatchObject({ ok: true, id })
  const registry = readRegistry(journalDir)
  expect(registry.state === 'ok' && Object.keys(registry.installations)).toEqual([id])
})

test('a corrupt registry with no manifests refuses admission, with instructions', () => {
  okId(resolveHome())
  const id = readdirSync(journalDir).find((name) => /^[0-9a-f]{16}$/.test(name))!
  rmSync(join(journalDir, id), { recursive: true })
  writeFileSync(registryFile(), 'garbage')
  const result = resolveHome()
  expect(result).toMatchObject({ ok: false, code: 'registry_corrupt' })
  expect(!result.ok && result.message).toMatch(/Restore it from a backup/)
  // Nothing was minted behind the person's back.
  expect(readFileSync(registryFile(), 'utf8')).toBe('garbage')
})

test('a missing registry with a damaged manifest refuses (cannot rule out an existing installation)', () => {
  const id = okId(resolveHome())
  rmSync(registryFile())
  writeFileSync(join(journalDir, id, MANIFEST_FILE), '{')
  expect(resolveHome()).toMatchObject({ ok: false, code: 'registry_corrupt' })
})

test('two entries claiming the path, or a home id that differs from the registry, refuse', () => {
  const id = okId(resolveHome())
  const registry = readRegistry(journalDir)
  if (registry.state !== 'ok') throw new Error('registry')
  const other = 'b'.repeat(16)
  registry.installations[other] = { ...registry.installations[id]! }
  writeFileSync(
    registryFile(),
    JSON.stringify({ version: 1, installations: registry.installations }),
  )
  expect(resolveHome()).toMatchObject({ ok: false, code: 'ambiguous_path' })
  // One entry again, but the home carries another id.
  delete registry.installations[other]
  writeFileSync(
    registryFile(),
    JSON.stringify({ version: 1, installations: registry.installations }),
  )
  writeFileSync(join(home, HOME_INSTALLATION_FILE), JSON.stringify({ version: 1, id: other }))
  expect(resolveHome()).toMatchObject({ ok: false, code: 'id_conflict' })
})

test('a copied home (new path, same installation.json) is refused until confirmed', () => {
  const id = okId(resolveHome())
  const copy = join(root, 'home-copy')
  cpSync(home, copy, { recursive: true })
  const result = resolveHome(copy)
  expect(result).toMatchObject({ ok: false, code: 'unconfirmed_path', id })
  expect(!result.ok && result.message).toMatch(/confirm-move/)
  // The refusal changed nothing: no new namespace, the registry still has one entry with one path.
  const registry = readRegistry(journalDir)
  expect(registry.state === 'ok' && Object.keys(registry.installations)).toEqual([id])
  expect(registry.state === 'ok' && registry.installations[id]!.paths).toHaveLength(1)
})

test('confirm-move keeps the id and the journal namespace; the old path is then refused as moved away', () => {
  const id = okId(resolveHome())
  const moved = join(root, 'home-moved')
  cpSync(home, moved, { recursive: true })
  rmSync(home, { recursive: true })
  expect(confirmMove({ journalDir, home: moved })).toMatchObject({ ok: true, id, changed: true })
  expect(resolveHome(moved)).toMatchObject({ ok: true, id, how: 'existing' })
  expect(confirmMove({ journalDir, home: moved })).toMatchObject({ ok: true, changed: false })
  // The old folder comes back (say a restored copy of it): refused, it is not the current location.
  mkdirSync(home)
  writeFileSync(join(home, HOME_INSTALLATION_FILE), JSON.stringify({ version: 1, id }))
  expect(resolveHome(home)).toMatchObject({ ok: false, code: 'moved_away', id })
  // The manifest lists both paths.
  const manifest = JSON.parse(readFileSync(join(journalDir, id, MANIFEST_FILE), 'utf8')) as {
    paths: string[]
  }
  expect(manifest.paths).toEqual([canonicalPath(home), canonicalPath(moved)])
})

test('confirm-copy mints a new id (registry first), keeps the source untouched and leaves a copy marker that fences', () => {
  const source = okId(resolveHome())
  const copy = join(root, 'home-copy')
  cpSync(home, copy, { recursive: true })
  const result = confirmCopy({ journalDir, home: copy })
  if (!result.ok) throw new Error(result.message)
  expect(result.id).not.toBe(source)
  const registry = readRegistry(journalDir)
  expect(registry.state === 'ok' && registry.installations[result.id]!.copiedFrom).toBe(source)
  expect(readHomeInstallation(copy)).toEqual({ state: 'ok', id: result.id })
  expect(readHomeInstallation(home)).toEqual({ state: 'ok', id: source })
  const marker = JSON.parse(
    readFileSync(join(journalDir, result.id, 'restore-marker.json'), 'utf8'),
  )
  expect(marker).toMatchObject({ scope: result.id, origin: 'copy' })
  expect(resolveHome(copy)).toMatchObject({ ok: true, id: result.id, how: 'existing' })
  expect(resolveHome(home)).toMatchObject({ ok: true, id: source })
  // Confirming something that is not an unconfirmed copy is refused.
  expect(confirmCopy({ journalDir, home: copy })).toMatchObject({ ok: false })
})

test('a home id nothing else remembers is adopted into the registry (lost state folder), not replaced by a new id', () => {
  const id = okId(resolveHome())
  rmSync(journalDir, { recursive: true })
  expect(resolveHome()).toMatchObject({ ok: true, id, how: 'adopted' })
})

test('restore finds the namespace through the registry, and the legacy directory when never migrated', () => {
  expect(restoreMarkerDir(journalDir, home)).toBe(canonicalPath(journalDir))
  const id = okId(resolveHome())
  expect(restoreMarkerDir(journalDir, home)).toBe(join(canonicalPath(journalDir), id))
})

test('registry operations are mutually exclusive across processes (registry-wide OS lock)', async () => {
  mkdirSync(journalDir, { recursive: true })
  const ready = join(root, 'ready')
  const child = fileURLToPath(new URL('./helpers/journal-child.ts', import.meta.url))
  const proc = spawn(
    process.execPath,
    [
      '--experimental-transform-types',
      '--no-warnings',
      child,
      'registry-hold',
      journalDir,
      '1500',
      ready,
    ],
    { stdio: 'ignore' },
  )
  const exited = new Promise((resolve) => proc.on('close', resolve))
  const deadline = Date.now() + 15_000
  while (!existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  const started = Date.now()
  const result = resolveHome() // blocks on the registry lock until the child lets go
  expect(Date.now() - started).toBeGreaterThan(800)
  expect(result.ok).toBe(true)
  await exited
}, 30_000)

test('FX3 #16: after A → B → A a lost registry is rebuilt with A current, not B', () => {
  const id = okId(resolveHome())
  const moved = join(root, 'home-moved')
  cpSync(home, moved, { recursive: true })
  expect(confirmMove({ journalDir, home: moved })).toMatchObject({ ok: true, changed: true })
  // And back: the original folder is the installation again.
  expect(confirmMove({ journalDir, home })).toMatchObject({ ok: true, changed: true })
  const manifest = JSON.parse(readFileSync(join(journalDir, id, MANIFEST_FILE), 'utf8')) as {
    paths: string[]
    current?: string
  }
  expect(manifest.paths).toEqual([canonicalPath(home), canonicalPath(moved)])
  expect(manifest.current).toBe(canonicalPath(home))
  rmSync(registryFile())
  expect(resolveHome(home)).toMatchObject({ ok: true, id })
  expect(resolveHome(moved)).toMatchObject({ ok: false, code: 'moved_away', id })
})

test('FX3 #10: confirm-copy carries the source journal into the copy, so inherited intents stay reconcilable', () => {
  const source = okId(resolveHome())
  const sourceJournal = join(journalDir, source, 'journal.ndjson')
  const body = {
    kind: 'send_started',
    attemptId: 'a1',
    orchestrationId: 'o1',
    attemptKind: 'step',
    agentId: 'builder',
    generation: 1,
    n: 1,
    at: '2026-10-12T10:00:00.000Z',
    scope: source,
  }
  const sum = (payload: string) => createHash('sha256').update(payload).digest('hex').slice(0, 16)
  writeFileSync(
    sourceJournal,
    `${JSON.stringify({ ...body, c: sum(JSON.stringify(body)) })}\n{"torn":`,
  )
  const copy = join(root, 'home-copy')
  cpSync(home, copy, { recursive: true })
  const result = confirmCopy({ journalDir, home: copy })
  if (!result.ok) throw new Error(result.message)
  const journal = new ExecutionJournal(join(journalDir, result.id), result.id)
  const read = journal.read()
  expect(read.ok && read.entries.map((e) => [e.n, e.kind, e.scope])).toEqual([
    [1, 'send_started', result.id],
  ])
  // A damaged source journal is not guessed at: nothing is published.
  const other = join(root, 'home-copy-2')
  cpSync(home, other, { recursive: true })
  writeFileSync(sourceJournal, '{"broken"\n')
  const refused = confirmCopy({ journalDir, home: other })
  expect(refused).toMatchObject({ ok: false })
  const registry = readRegistry(journalDir)
  expect(registry.state === 'ok' && Object.keys(registry.installations)).toHaveLength(2)
})
