import { spawn } from 'node:child_process'
import {
  existsSync,
  fsyncSync as realSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync as realWriteSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  ExecutionJournal,
  JOURNAL_FILE,
  type JournalEntryBody,
  type JournalIo,
} from '../../src/domain/orchestration/journal.ts'
import { OsLockTimeoutError } from '../../src/locks/os-lock.ts'

// Z1 and Z2 (7.7a v4 review #2 and #3): a record is written whole or the caller never proceeds, and the journal's
// operations are mutually exclusive across processes through an OS lock.

const child = fileURLToPath(new URL('../helpers/journal-child.ts', import.meta.url))
let dir: string
const started: number[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-journal-dur-'))
})
afterEach(() => {
  for (const pid of started.splice(0))
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already exited
    }
  rmSync(dir, { recursive: true, force: true })
})

const send = (id: string): JournalEntryBody => ({
  kind: 'send_started',
  attemptId: id,
  orchestrationId: 'o1',
  attemptKind: 'step',
  agentId: 'builder',
  generation: 1,
})
const real: JournalIo = { writeSync: (...a) => realWrite(...a), fsyncSync: (fd) => realSync(fd) }
const realWrite = (fd: number, buf: Buffer, off: number, len: number) =>
  realWriteSync(fd, buf, off, len)
const ids = (d: string, scope = 'home') => {
  const read = new ExecutionJournal(d, scope).read()
  if (!read.ok) throw new Error(read.reason)
  return read.entries.map((e) => (e.kind === 'send_started' ? e.attemptId : e.kind))
}
/** The caller's pattern: the effect happens only after append returned. */
function guarded(journal: ExecutionJournal, id: string): { effect: boolean; error?: unknown } {
  let effect = false
  try {
    journal.append(send(id))
    effect = true
  } catch (error) {
    return { effect, error }
  }
  return { effect }
}

test('a short write is completed: the record is whole before append returns', () => {
  const calls: number[] = []
  const io: JournalIo = {
    writeSync: (fd, buf, off, len) => {
      const n = Math.min(7, len) // never more than 7 bytes at a time
      calls.push(n)
      return real.writeSync(fd, buf, off, n)
    },
    fsyncSync: real.fsyncSync,
  }
  const journal = new ExecutionJournal(dir, 'home', Date.now, undefined, io)
  expect(guarded(journal, 'a1').effect).toBe(true)
  expect(calls.length).toBeGreaterThan(5)
  expect(ids(dir)).toEqual(['a1'])
  expect(readFileSync(join(dir, JOURNAL_FILE), 'utf8').endsWith('\n')).toBe(true)
})

test('a write that stops making progress throws, leaves no partial record, and the caller never acts', () => {
  let first = true
  const io: JournalIo = {
    writeSync: (fd, buf, off) => {
      if (first) {
        first = false
        return real.writeSync(fd, buf, off, 10) // a partial write ...
      }
      return 0 // ... then no progress
    },
    fsyncSync: real.fsyncSync,
  }
  const journal = new ExecutionJournal(dir, 'home', Date.now, undefined, io)
  const result = guarded(journal, 'a1')
  expect(result.effect).toBe(false)
  expect(String(result.error)).toMatch(/no progress/)
  // Restart: no record and nothing a restart would have to discard.
  expect(readFileSync(join(dir, JOURNAL_FILE), 'utf8')).toBe('')
  expect(ids(dir)).toEqual([])
  // The next append works and takes the same number.
  const again = new ExecutionJournal(dir, 'home')
  expect(again.append(send('a2')).n).toBe(1)
})

test('an fsync failure throws before the caller acts and the record does not stay', () => {
  const io: JournalIo = {
    writeSync: real.writeSync,
    fsyncSync: () => {
      throw new Error('EIO')
    },
  }
  const journal = new ExecutionJournal(dir, 'home', Date.now, undefined, io)
  expect(guarded(journal, 'a1').effect).toBe(false)
  expect(ids(dir)).toEqual([])
})

test('a directory-sync failure for a new journal throws, and is retried by the next append', () => {
  let calls = 0
  const failDir = true
  const io: JournalIo = {
    writeSync: real.writeSync,
    fsyncSync: (fd) => {
      calls++
      if (calls === 2 && failDir) throw new Error('EIO on directory') // 1 = file, 2 = directory
      real.fsyncSync(fd)
    },
  }
  const journal = new ExecutionJournal(dir, 'home', Date.now, undefined, io)
  const first = guarded(journal, 'a1')
  expect(first.effect).toBe(false)
  expect(String(first.error)).toMatch(/directory/)
  // The same handle retries the directory sync before it allows an effect; here the fsync calls are 3 (file) and 4 (dir).
  expect(guarded(journal, 'a2').effect).toBe(true)
  expect(calls).toBe(4)
})

test('compaction writes its whole temp file or throws, leaving the journal untouched', () => {
  const journal = new ExecutionJournal(dir, 'home')
  for (const id of ['a1', 'a2', 'a3']) journal.append(send(id))
  const before = readFileSync(join(dir, JOURNAL_FILE), 'utf8')
  const broken: JournalIo = { writeSync: () => 0, fsyncSync: real.fsyncSync }
  const failing = new ExecutionJournal(dir, 'home', Date.now, undefined, broken)
  expect(() => failing.compact(() => true)).toThrow(/no progress/)
  expect(readFileSync(join(dir, JOURNAL_FILE), 'utf8')).toBe(before)
  expect(existsSync(join(dir, `${JOURNAL_FILE}.tmp`))).toBe(false)
  const short: JournalIo = {
    writeSync: (fd, buf, off, len) => real.writeSync(fd, buf, off, Math.min(5, len)),
    fsyncSync: real.fsyncSync,
  }
  const ok = new ExecutionJournal(dir, 'home', Date.now, undefined, short)
  expect(ok.compact(() => true).dropped).toBeGreaterThanOrEqual(0)
  expect(ids(dir)).toHaveLength(3)
})

test('a torn tail left by a crashed writer is cut before the next append, never glued to it', () => {
  const journal = new ExecutionJournal(dir, 'home')
  journal.append(send('a1'))
  writeFileSync(
    join(dir, JOURNAL_FILE),
    readFileSync(join(dir, JOURNAL_FILE), 'utf8') + '{"n":2,"par',
  )
  const other = new ExecutionJournal(dir, 'home')
  other.append(send('a2'))
  expect(ids(dir)).toEqual(['a1', 'a2'])
})

// ---- Z2: OS lock across processes ------------------------------------------------------------------------------

function startHolder(): { pid: number; ready: string; go: string; done: Promise<unknown> } {
  const ready = join(dir, 'hold-ready')
  const go = join(dir, 'hold-go')
  const proc = spawn(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', child, 'hold', dir, ready, go],
    { stdio: 'ignore' },
  )
  started.push(proc.pid!)
  return { pid: proc.pid!, ready, go, done: new Promise((resolve) => proc.on('close', resolve)) }
}
const until = async (check: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('while another process holds the journal lock, append waits and then times out with a clear error', async () => {
  const holder = startHolder()
  await until(() => existsSync(holder.ready))
  const journal = new ExecutionJournal(dir, 'home', Date.now, undefined, undefined, 300)
  const result = guarded(journal, 'a1')
  expect(result.effect).toBe(false)
  expect(result.error).toBeInstanceOf(OsLockTimeoutError)
  // Reads do not claim the journal is damaged just because the lock is busy.
  expect(journal.read()).toMatchObject({ ok: false, reason: 'the journal lock is busy' })
  writeFileSync(holder.go, 'x')
  await holder.done
  expect(guarded(journal, 'a2').effect).toBe(true)
})

test('a holder killed with SIGKILL releases the journal lock at once', async () => {
  const holder = startHolder()
  await until(() => existsSync(holder.ready))
  process.kill(holder.pid, 'SIGKILL')
  await holder.done
  const journal = new ExecutionJournal(dir, 'home', Date.now, undefined, undefined, 2000)
  const t0 = Date.now()
  expect(guarded(journal, 'a1').effect).toBe(true)
  expect(Date.now() - t0).toBeLessThan(1500)
})

test('compaction in this process and appends in another never lose an append', async () => {
  const journal = new ExecutionJournal(dir, 'scope-x')
  journal.append(send('seed'))
  const proc = spawn(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', child, 'append', dir, '120'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  started.push(proc.pid!)
  const exited = new Promise<number | null>((resolve) => proc.on('close', resolve))
  let finished = false
  void exited.then(() => (finished = true))
  while (!finished) {
    journal.compact(() => true)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  expect(await exited).toBe(0)
  journal.compact(() => true)
  const read = journal.read()
  if (!read.ok) throw new Error(read.reason)
  const seen = new Set(
    read.entries.flatMap((e) =>
      e.kind === 'send_started' || (e.kind === 'tombstone' && e.attemptId)
        ? [(e as { attemptId: string }).attemptId]
        : [],
    ),
  )
  for (let i = 0; i < 120; i++) expect(seen.has(`child-${i}`)).toBe(true)
  // Numbers are strictly increasing, which the parser enforces.
  expect(read.entries.length).toBeGreaterThan(100)
})
