import { createHash, randomUUID } from 'node:crypto'
import { constants as C, createReadStream, type ReadStream } from 'node:fs'
import os from 'node:os'
import { watch, type FSWatcher, type Stats } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type {
  KnowledgeAuthor,
  KnowledgeChanged,
  KnowledgeCommit,
  KnowledgeHistoryStatus,
  KnowledgeInfo,
  KnowledgeNote,
  KnowledgeSearchHit,
  KnowledgeTree,
  KnowledgeWriteRequest,
} from '@score/contract'
import { KnowledgeAuthorSchema } from '@score/contract'
import type { ScoreDb } from '../db/index.ts'
import type { DatabaseSync } from 'node:sqlite'
import { HttpError } from '../errors.ts'
import { VaultGit } from './git.ts'
import { forIndex, prepareNoteContent } from './note-images.ts'
import { moveNoReplace, syncDir } from './move-file.ts'
import { buildNoteIndex, parseWikilinks, resolveLink, rewriteLinks } from './links.ts'
import {
  authorFromColumn,
  authorToColumn,
  etagOf,
  hashContent,
  MAX_NOTE_BYTES,
  noteTitle,
  parseNote,
  parseNotePath,
  parseVaultPath,
  serialiseNote,
} from './note.ts'
import { SEED_NOTES } from './seed.ts'
import { isDocumentPath, MAX_READ_BYTES, MAX_STORE_BYTES } from './doc-types.ts'
import { KnowledgeDocuments } from './documents.ts'
import { buildMonthIndex, memoryMonthDir } from './memory-notes.ts'

// The central vault (contract §12, design 6.0 § 6.2). Files are the source of truth; the DB only indexes them.
// Everything that changes files runs through one lock, so scans, saves and git never interleave. Nothing here is
// Hermes-specific.

export interface VaultLog {
  warn(object: object, message: string): void
}

export interface VaultOptions {
  vault: string
  db: ScoreDb
  /** Publishes `knowledge.changed`; failures are logged, never thrown into a save. */
  emit: (change: KnowledgeChanged) => void | Promise<unknown>
  log?: VaultLog
  now?: () => number
  /** Quiet time after the last file-system event before a scan. */
  debounceMs?: number
  /** Full scan interval (covers missed watcher events). */
  scanIntervalMs?: number
  /** Fake mode: write neutral example notes into an empty vault. */
  seed?: boolean
  /** Tests: do not use fs.watch. */
  watch?: boolean
  /** Score's own state for Knowledge (`$SCORE_HOME/knowledge`): the move plan lives here, never in the vault. */
  stateDir?: string
  /** Tests: first retry delay for an interrupted move that couldn't be finished (doubles up to 5 minutes). */
  moveRetryMs?: number
}

const NoteRowSchema = z.object({
  id: z.number(),
  path: z.string(),
  title: z.string(),
  mtime_ms: z.number(),
  size: z.number(),
  hash: z.string(),
  frontmatter_json: z.string(),
  last_author: z.string().nullable(),
})
type NoteRow = z.infer<typeof NoteRowSchema>
const LinkRowSchema = z.object({
  rowid: z.number(),
  from_path: z.string(),
  to_target: z.string(),
  to_path: z.string().nullable(),
})

const FileIdentitySchema = z.object({
  dev: z.number(),
  ino: z.number(),
  birthtimeMs: z.number(),
  size: z.number(),
  /** Content hash; absent for the identity read off the destination right after the rename. */
  hash: z.string().optional(),
})
type FileIdentity = z.infer<typeof FileIdentitySchema>

const MovePlanSchema = z.object({
  from: z.string(),
  to: z.string(),
  author: KnowledgeAuthorSchema,
  items: z.array(
    z.object({
      path: z.string(),
      baseHash: z.string(),
      newHash: z.string(),
      content: z.string(),
      done: z.boolean(),
      skipped: z.boolean(),
      reason: z.string().optional(),
    }),
  ),
  /** Older versions parked the old name while removing it; such a plan is only reported, never interpreted. */
  parked: z.string().optional(),
  /** What the source was before the move; recovery accepts the destination as the moved file only if it matches. */
  identity: FileIdentitySchema.optional(),
  /** `conflicted`: recovery found the evidence doesn't add up; the plan is kept, shown, and not retried. */
  state: z.enum(['active', 'conflicted']).default('active'),
  detail: z.string().optional(),
})
type MovePlan = z.infer<typeof MovePlanSchema>
/** Kept in memory and shown on the Knowledge page while a move plan needs attention. */
export interface MoveIssue {
  state: 'pending' | 'conflicted'
  from: string
  to: string
  message: string
}
export interface MoveSkipped {
  path: string
  reason: string
}

const READ_CHUNK_BYTES = 256 * 1024
const MAX_FILES = 100_000
const MAX_DEPTH = 32
const MAX_EVENTS_PER_SCAN = 200
const README = `# Knowledge

Notes shared by you and your agents. Plain Markdown files with optional frontmatter; link notes with [[wikilinks]].
Every save is a git commit, so nothing is ever lost.
`

/** A stat that failed because the path is genuinely gone (anything else is "couldn't verify"). */
function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export interface HistoryOutcome {
  history: KnowledgeHistoryStatus
  /** False when the path has no history by design or because git is missing. */
  versioned: boolean
  /** False when the save did not reach history (`failed`, `git_unavailable`). */
  historyUpdated: boolean
}

function historyOutcome(history: KnowledgeHistoryStatus, partlyIgnored = false): HistoryOutcome {
  return {
    history,
    versioned: !partlyIgnored && history !== 'not_versioned' && history !== 'git_unavailable',
    historyUpdated: history !== 'failed' && history !== 'git_unavailable',
  }
}

export class KnowledgeVault {
  readonly git: VaultGit
  /** Uploaded documents (PLAN 6.6); share this vault's lock, git and index. */
  readonly docs: KnowledgeDocuments
  private root: string
  private readonly now: () => number
  private queue: Promise<unknown> = Promise.resolve()
  private watcher: FSWatcher | undefined
  private debounce: NodeJS.Timeout | undefined
  private interval: NodeJS.Timeout | undefined
  private closed = false
  private issue: MoveIssue | null = null
  private retryTimer: NodeJS.Timeout | undefined
  private retryDelayMs: number
  /** Paths the watcher reported since the last scan. */
  private dirty = new Set<string>()
  private verifyNext = false

  constructor(private readonly options: VaultOptions) {
    this.root = path.resolve(options.vault)
    this.now = options.now ?? Date.now
    this.retryDelayMs = options.moveRetryMs ?? 2000
    this.git = new VaultGit(this.root, this.now)
    this.docs = new KnowledgeDocuments(this, options.db)
    // Stored-only documents (over 10 MB) are not in git, so "Outside changes" must not sweep them in.
    this.git.setIgnore(() => this.docs.unversionedPaths())
  }

  get vault(): string {
    return this.root
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Runs `work` under the vault lock (for the documents module). */
  runLocked<T>(work: () => Promise<T>): Promise<T> {
    return this.serial(work)
  }

  publishChange(change: KnowledgeChanged): Promise<void> {
    return this.publish(change)
  }

  private async publish(change: KnowledgeChanged): Promise<void> {
    try {
      await this.options.emit(change)
    } catch (error) {
      this.options.log?.warn({ err: error }, 'Could not publish a knowledge change')
    }
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------

  /** Creates the vault on first use (`git init`, README.md, optional seed), indexes it, starts the watcher. */
  async start(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
    this.root = await fs.realpath(this.root)
    this.git.setVault(this.root)
    const hasGitDir = await fs
      .lstat(path.join(this.root, '.git'))
      .then(() => true)
      .catch(() => false)
    await this.git.init(hasGitDir)
    await this.serial(async () => {
      await this.migrateLegacyPlan().catch((error: unknown) =>
        this.options.log?.warn({ err: error }, 'Couldn’t move an old move plan'),
      )
      await this.recoverMove()
      const entries = (await fs.readdir(this.root)).filter((name) => name !== '.git')
      const fresh = entries.length === 0
      if (fresh) {
        await this.atomicWrite(path.join(this.root, 'README.md'), README)
        if (this.options.seed)
          for (const [rel, content] of Object.entries(SEED_NOTES)) {
            await fs.mkdir(path.dirname(path.join(this.root, rel)), { recursive: true })
            await this.atomicWrite(path.join(this.root, rel), content)
          }
      }
      if (this.git.available && !(await this.git.hasCommits()))
        await this.git.commit({
          paths: ['.'],
          message: 'Create vault',
          author: 'you',
        })
      await this.scan(false)
      await this.docs
        .reconcileHistory()
        .catch((error: unknown) =>
          this.options.log?.warn({ err: error }, 'Couldn’t check which documents are in history'),
        )
      await this.fillAuthors()
    })
    if (this.options.watch !== false) this.startWatching()
    this.interval = setInterval(
      () =>
        void this.serial(() => this.scan(true, true)).catch((error: unknown) =>
          this.logScan(error),
        ),
      this.options.scanIntervalMs ?? 5 * 60_000,
    )
    this.interval.unref()
  }

  private logScan(error: unknown): void {
    this.options.log?.warn({ err: error }, 'Knowledge scan failed')
  }

  private startWatching(): void {
    const debounceMs = this.options.debounceMs ?? 400
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        // Git's own files change on every commit; hidden files are not part of the vault.
        if (
          filename &&
          String(filename)
            .split(path.sep)
            .some((part) => part.startsWith('.'))
        )
          return
        if (filename) this.dirty.add(String(filename).split(path.sep).join('/'))
        else this.verifyNext = true
        clearTimeout(this.debounce)
        this.debounce = setTimeout(
          () =>
            void this.serial(() => this.scan(true)).catch((error: unknown) => this.logScan(error)),
          debounceMs,
        )
      })
      this.watcher.on('error', (error) => {
        this.options.log?.warn(
          { err: error },
          'Knowledge watcher stopped; the periodic scan continues',
        )
        this.watcher?.close()
      })
    } catch (error) {
      this.options.log?.warn(
        { err: error },
        'Knowledge watcher unavailable; the periodic scan continues',
      )
    }
  }

  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.debounce)
    clearInterval(this.interval)
    clearTimeout(this.retryTimer)
    this.watcher?.close()
    await this.queue.catch(() => undefined)
  }

  // ---- paths and files ---------------------------------------------------------------------------------------

  /**
   * Walks the segments from the vault root without following symlinks. Missing parents give `exists: false`;
   * a symlink or a file in the way is refused. Returns the absolute path of the last segment.
   */
  async lookup(segments: string[]): Promise<{ abs: string; stat: Stats | null }> {
    let current = this.root
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment)
      let stat
      try {
        stat = await fs.lstat(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { abs: path.join(this.root, ...segments), stat: null }
        }
        throw error
      }
      if (stat.isSymbolicLink())
        throw new HttpError(400, 'bad_path', 'Score doesn’t follow links inside Knowledge.')
      const last = index === segments.length - 1
      if (!last && !stat.isDirectory())
        throw new HttpError(400, 'bad_path', 'A file is in the way of that folder.')
      if (last) return { abs: current, stat }
    }
    return { abs: current, stat: null }
  }

  /** Creates missing parent folders, then checks the real parent is still inside the vault (symlink race). */
  async prepareParent(rel: string): Promise<string> {
    const abs = path.join(this.root, ...rel.split('/'))
    const parent = path.dirname(abs)
    await fs.mkdir(parent, { recursive: true })
    await this.assertParent(parent)
    return abs
  }

  private async assertParent(parent: string): Promise<void> {
    const real = await fs.realpath(parent)
    if (real !== parent)
      throw new HttpError(400, 'bad_path', 'That folder points outside Knowledge.')
  }

  /** The hashes the file at `abs` may be known by (bytes; for a small file also its UTF-8 round trip); `[null]` when there is none. */
  private async currentHashes(abs: string): Promise<Array<string | null>> {
    try {
      const size = (await fs.lstat(abs)).size
      if (size > MAX_READ_BYTES) return [await this.hashContained(abs, MAX_STORE_BYTES)]
      const bytes = await this.readContainedBuffer(abs, MAX_READ_BYTES)
      return [hashContent(bytes), hashContent(bytes.toString('utf8'))]
    } catch {
      return [null]
    }
  }

  /**
   * `expect`: the content hash the target must still have (null = must not exist) right before it is replaced.
   * A new target is published with `link`, which never replaces; an existing one is replaced only while it still
   * has the expected hash. Without `expect` the target is replaced unconditionally (restores, seeds).
   * `durable`: the new content and the folder entry are flushed to disk before returning.
   */
  async atomicWrite(
    abs: string,
    content: string | Uint8Array,
    expect?: { hash: string | null },
    durable = false,
  ): Promise<void> {
    const parent = path.dirname(abs)
    const temp = path.join(parent, `.score-${randomUUID()}.tmp`)
    try {
      const handle = await fs.open(temp, 'wx', 0o644)
      try {
        await handle.writeFile(content)
        if (durable) await handle.sync()
      } finally {
        await handle.close()
      }
      await this.assertParent(parent)
      if (expect) {
        const now = await this.currentHashes(abs)
        if (!now.includes(expect.hash)) {
          const first = now[0] ?? null
          throw new HttpError(412, 'precondition_failed', 'The note changed after you opened it.', {
            etag: first === null ? null : etagOf(first),
          })
        }
      }
      if (expect?.hash === null) {
        await this.moveNoReplace(temp, abs)
      } else {
        await fs.rename(temp, abs)
        if (durable) await syncDir(parent)
      }
      await this.assertParent(parent)
    } catch (error) {
      await fs.rm(temp, { force: true })
      throw error
    }
  }

  /** Moves `source` to `dest`, failing with 409 instead of replacing anything there (see move-file.ts). */
  async moveNoReplace(source: string, dest: string): Promise<{ synced: boolean }> {
    return moveNoReplace(source, dest)
  }

  /**
   * Reads a file that must live at exactly `abs` inside the vault: opened without following a symlink in the last
   * component, and on Linux the open descriptor's real path must still be `abs`, so a folder swapped for a symlink
   * after the path was checked cannot make Score read (and index) a file elsewhere.
   */
  private async readContained(abs: string): Promise<string> {
    return (await this.readContainedBuffer(abs)).toString('utf8')
  }

  /** Opens a plain file inside the vault: no symlink at the end, and the descriptor must still be at `abs` (Linux). */
  private async openContained(abs: string): Promise<FileHandle> {
    const handle = await fs.open(abs, C.O_RDONLY | C.O_NOFOLLOW)
    try {
      if (process.platform === 'linux') {
        const actual = await fs.realpath(`/proc/self/fd/${handle.fd}`)
        if (actual !== abs)
          throw new HttpError(400, 'bad_path', 'The note moved while it was being read.')
      }
      return handle
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  /** `maxBytes` is checked on the open descriptor and while reading, so a file that grows after the size check cannot be slurped whole. */
  async readContainedBuffer(abs: string, maxBytes = MAX_NOTE_BYTES): Promise<Buffer> {
    const handle = await this.openContained(abs)
    try {
      const tooLarge = () =>
        new HttpError(413, 'payload_too_large', 'That file is too large to open.')
      if ((await handle.stat()).size > maxBytes) throw tooLarge()
      const chunks: Buffer[] = []
      let total = 0
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total))
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        if (bytesRead === 0) break
        total += bytesRead
        if (total > maxBytes) throw tooLarge()
        chunks.push(chunk.subarray(0, bytesRead))
      }
      return Buffer.concat(chunks, total)
    } finally {
      await handle.close()
    }
  }

  /** The SHA-256 of a file, read in chunks (never whole), with the same containment and size checks as the buffer reader. */
  async hashContained(abs: string, maxBytes: number): Promise<string> {
    const handle = await this.openContained(abs)
    try {
      if ((await handle.stat()).size > maxBytes)
        throw new HttpError(413, 'payload_too_large', 'That file is too large to open.')
      const hash = createHash('sha256')
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES)
      let total = 0
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        if (bytesRead === 0) break
        total += bytesRead
        // A file that grows while it is read is refused, like in the buffer reader.
        if (total > maxBytes)
          throw new HttpError(413, 'payload_too_large', 'That file is too large to open.')
        hash.update(chunk.subarray(0, bytesRead))
      }
      return hash.digest('hex')
    } finally {
      await handle.close()
    }
  }

  /** The first `bytes` bytes of a file (fewer when it is shorter). */
  async readContainedHead(abs: string, bytes: number): Promise<Buffer> {
    const handle = await this.openContained(abs)
    try {
      const head = Buffer.alloc(bytes)
      const { bytesRead } = await handle.read(head, 0, bytes, 0)
      return head.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  /**
   * A file to stream out: its size, its first bytes (for sniffing) and a stream from the same descriptor. The stream
   * closes the descriptor when it ends or is destroyed.
   */
  async openContainedStream(
    abs: string,
    maxBytes: number,
    headBytes = 64,
  ): Promise<{ size: number; head: Buffer; stream: ReadStream }> {
    const handle = await this.openContained(abs)
    try {
      const stat = await handle.stat()
      if (stat.size > maxBytes)
        throw new HttpError(413, 'payload_too_large', 'That file is too large.')
      const head = Buffer.alloc(Math.min(headBytes, stat.size))
      await handle.read(head, 0, head.length, 0)
      // `end` pins the length announced to the client even if the file grows meanwhile.
      const stream = createReadStream('', {
        fd: handle,
        start: 0,
        end: Math.max(stat.size - 1, 0),
        autoClose: true,
      })
      return { size: stat.size, head, stream }
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  private async readRaw(abs: string, stat: Stats): Promise<string> {
    if (!stat.isFile()) throw new HttpError(400, 'not_a_note', 'That isn’t a note.')
    if (stat.size > MAX_NOTE_BYTES)
      throw new HttpError(413, 'payload_too_large', 'That note is too large to open.')
    return this.readContained(abs)
  }

  // ---- index -------------------------------------------------------------------------------------------------

  private noteRows(sqlite: DatabaseSync): NoteRow[] {
    return sqlite
      .prepare('SELECT * FROM knowledge_notes ORDER BY path')
      .all()
      .map((row) => NoteRowSchema.parse(row))
  }

  private noteRow(sqlite: DatabaseSync, rel: string): NoteRow | undefined {
    const row = sqlite.prepare('SELECT * FROM knowledge_notes WHERE path = ?').get(rel)
    return row === undefined ? undefined : NoteRowSchema.parse(row)
  }

  private upsert(
    sqlite: DatabaseSync,
    rel: string,
    file: { mtimeMs: number; size: number; hash: string },
    raw: string,
    author: KnowledgeAuthor | null,
  ): void {
    const parsed = parseNote(raw)
    const title = noteTitle(rel, parsed.frontmatter, parsed.body)
    const existing = this.noteRow(sqlite, rel)
    const column = author === null ? (existing?.last_author ?? null) : authorToColumn(author)
    let id: number
    if (existing) {
      id = existing.id
      sqlite
        .prepare(
          'UPDATE knowledge_notes SET title = ?, mtime_ms = ?, size = ?, hash = ?, frontmatter_json = ?, last_author = ? WHERE id = ?',
        )
        .run(
          title,
          Math.trunc(file.mtimeMs),
          file.size,
          file.hash,
          JSON.stringify(parsed.frontmatter),
          column,
          id,
        )
    } else {
      const result = sqlite
        .prepare(
          'INSERT INTO knowledge_notes (path, title, mtime_ms, size, hash, frontmatter_json, last_author) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          rel,
          title,
          Math.trunc(file.mtimeMs),
          file.size,
          file.hash,
          JSON.stringify(parsed.frontmatter),
          column,
        )
      id = Number(result.lastInsertRowid)
    }
    sqlite.prepare('DELETE FROM knowledge_fts WHERE rowid = ?').run(id)
    sqlite
      .prepare('INSERT INTO knowledge_fts (rowid, path, title, body) VALUES (?, ?, ?, ?)')
      .run(id, rel, title, forIndex(parsed.body))
    sqlite.prepare('DELETE FROM knowledge_links WHERE from_path = ?').run(rel)
    const seen = new Set<string>()
    for (const link of parseWikilinks(parsed.body)) {
      if (seen.has(link.target)) continue
      seen.add(link.target)
      sqlite
        .prepare('INSERT INTO knowledge_links (from_path, to_target, to_path) VALUES (?, ?, NULL)')
        .run(rel, link.target)
    }
  }

  private remove(sqlite: DatabaseSync, rel: string): void {
    const existing = this.noteRow(sqlite, rel)
    if (!existing) return
    sqlite.prepare('DELETE FROM knowledge_fts WHERE rowid = ?').run(existing.id)
    sqlite.prepare('DELETE FROM knowledge_notes WHERE id = ?').run(existing.id)
    sqlite.prepare('DELETE FROM knowledge_links WHERE from_path = ?').run(rel)
  }

  /** Re-resolves every link: a new, removed or moved note changes what other notes' links point at. */
  private relink(sqlite: DatabaseSync): void {
    const index = buildNoteIndex(this.noteRows(sqlite).map((row) => row.path))
    const rows = sqlite
      .prepare('SELECT rowid, from_path, to_target, to_path FROM knowledge_links')
      .all()
      .map((row) => LinkRowSchema.parse(row))
    const update = sqlite.prepare('UPDATE knowledge_links SET to_path = ? WHERE rowid = ?')
    for (const row of rows) {
      const resolved = resolveLink(row.to_target, row.from_path, index)
      if (resolved !== row.to_path) update.run(resolved, row.rowid)
    }
  }

  /** Indexes one file after a Score write (caller holds the lock). */
  private async indexFile(
    rel: string,
    author: KnowledgeAuthor,
  ): Promise<{ hash: string; raw: string; mtimeMs: number }> {
    const { abs, stat } = await this.lookup(rel.split('/'))
    if (!stat?.isFile()) throw new HttpError(404, 'not_found', 'Couldn’t find that note.')
    if (stat.size > MAX_NOTE_BYTES)
      throw new HttpError(413, 'payload_too_large', 'That note is too large to open.')
    const raw = await this.readContained(abs)
    const hash = hashContent(raw)
    this.options.db.tx((sqlite) => {
      this.upsert(sqlite, rel, { mtimeMs: stat.mtimeMs, size: stat.size, hash }, raw, author)
      this.relink(sqlite)
    })
    return { hash, raw, mtimeMs: stat.mtimeMs }
  }

  private async walk(): Promise<{
    files: Map<string, { mtimeMs: number; size: number }>
    documents: Map<string, { mtimeMs: number; size: number }>
    folders: string[]
    /** Folders (relative; '' = the whole vault) or single files whose state could not be verified. */
    incomplete: Set<string>
  }> {
    const incomplete = new Set<string>()
    const files = new Map<string, { mtimeMs: number; size: number }>()
    const documents = new Map<string, { mtimeMs: number; size: number }>()
    const folders: string[] = []
    const visit = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) {
        incomplete.add(rel)
        return
      }
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        incomplete.add(rel)
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (entry.isDirectory()) {
          folders.push(childRel)
          await visit(path.join(dir, entry.name), childRel, depth + 1)
        } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
          if (files.size >= MAX_FILES) {
            incomplete.add('')
            continue
          }
          try {
            const stat = await fs.lstat(path.join(dir, entry.name))
            files.set(childRel, { mtimeMs: stat.mtimeMs, size: stat.size })
          } catch (error) {
            // ENOENT: vanished between readdir and stat. Anything else proves nothing about this file.
            if (!isNotFound(error)) incomplete.add(childRel)
          }
        } else if (entry.isFile() && isDocumentPath(entry.name)) {
          if (documents.size >= MAX_FILES) {
            incomplete.add('')
            continue
          }
          try {
            const stat = await fs.lstat(path.join(dir, entry.name))
            documents.set(childRel, { mtimeMs: stat.mtimeMs, size: stat.size })
          } catch (error) {
            // ENOENT: vanished between readdir and stat. Anything else proves nothing about this file.
            if (!isNotFound(error)) incomplete.add(childRel)
          }
        }
      }
    }
    await visit(this.root, '', 0)
    return { files, documents, folders: folders.sort(), incomplete }
  }

  /**
   * Brings the index in line with the files: new and changed by `(mtime, size)` then hash, removed dropped.
   * With `announce`, each change is published as made by "outside" (an edit Score did not make).
   */
  private async scan(announce: boolean, verifyAll = false): Promise<string[]> {
    if (this.closed) return []
    // Paths the watcher reported are hashed even when (mtime, size) look unchanged: an edit can keep both.
    const dirty = this.dirty
    this.dirty = new Set()
    const everything = verifyAll || this.verifyNext
    this.verifyNext = false
    const verify = (rel: string): boolean => everything || dirty.has(rel)
    const { files, documents, incomplete } = await this.walk()
    // A folder that could not be listed proves nothing about what is in it: its notes stay indexed.
    const covered = (rel: string): boolean =>
      ![...incomplete].some((dir) => dir === '' || rel === dir || rel.startsWith(`${dir}/`))
    if (incomplete.size > 0)
      this.options.log?.warn(
        { folders: [...incomplete].slice(0, 20) },
        'Some vault folders could not be listed; their notes were left as they are',
      )
    const known = new Map(
      this.options.db.read((sqlite) => this.noteRows(sqlite)).map((row) => [row.path, row]),
    )
    const removed = [...known.keys()].filter((rel) => {
      const file = files.get(rel)
      return file ? file.size > MAX_NOTE_BYTES : covered(rel)
    })
    const touched: Array<{
      rel: string
      file: { mtimeMs: number; size: number; hash: string }
      raw: string | null
    }> = []
    for (const [rel, stat] of files) {
      if (stat.size > MAX_NOTE_BYTES) continue
      const row = known.get(rel)
      if (
        row &&
        !verify(rel) &&
        Math.trunc(stat.mtimeMs) === row.mtime_ms &&
        stat.size === row.size
      )
        continue
      let raw: string
      try {
        raw = await this.readContained(path.join(this.root, rel))
      } catch {
        continue // vanished, or no longer a plain file inside the vault
      }
      const hash = hashContent(raw)
      touched.push({
        rel,
        file: { mtimeMs: stat.mtimeMs, size: stat.size, hash },
        raw: row?.hash === hash ? null : raw,
      })
    }
    const changed: string[] = []
    this.options.db.tx((sqlite) => {
      for (const rel of removed) {
        this.remove(sqlite, rel)
        changed.push(rel)
      }
      for (const { rel, file, raw } of touched) {
        if (raw === null) {
          sqlite
            .prepare('UPDATE knowledge_notes SET mtime_ms = ?, size = ? WHERE path = ?')
            .run(Math.trunc(file.mtimeMs), file.size, rel)
          continue
        }
        this.upsert(sqlite, rel, file, raw, announce || known.has(rel) ? 'outside' : null)
        changed.push(rel)
      }
      if (changed.length > 0) this.relink(sqlite)
    })
    changed.push(...(await this.docs.scan(documents, announce, verify, covered)))
    await this.refreshMemoryIndexes(changed)
    if (announce)
      for (const rel of changed
        .filter((item) => !isDocumentPath(item))
        .slice(0, MAX_EVENTS_PER_SCAN))
        await this.publish({
          path: rel,
          kind: files.has(rel) ? 'written' : 'deleted',
          to: null,
          by: 'outside',
        })
    return changed
  }

  /** Rebuilds the monthly memory indexes of the memory notes that changed (inside the vault lock). */
  private async refreshMemoryIndexes(
    changed: string[],
    author: KnowledgeAuthor = 'outside',
  ): Promise<void> {
    const dirs = new Set(changed.flatMap((rel) => memoryMonthDir(rel) ?? []))
    for (const dir of dirs)
      await this.writeMemoryIndex(dir, author).catch((error: unknown) =>
        this.options.log?.warn({ err: error }, 'Couldn’t rebuild a memory index'),
      )
  }

  /** Writes `<dir>/index.md` from the indexed notes of that month; leaves it alone when it is already right. */
  private async writeMemoryIndex(dir: string, author: KnowledgeAuthor): Promise<void> {
    const rel = `${dir}/index.md`
    const prefix = `${dir}/`
    const entries = this.options.db
      .read((sqlite) => this.noteRows(sqlite))
      .filter((row) => row.path.startsWith(prefix) && memoryMonthDir(row.path) === dir)
      .map((row) => ({
        path: row.path,
        title: row.title,
        frontmatter: z.record(z.string(), z.unknown()).parse(JSON.parse(row.frontmatter_json)),
      }))
    const { abs, stat } = await this.lookup(rel.split('/'))
    if (entries.length === 0 && !stat) return
    const content = buildMonthIndex(dir, entries)
    const current = stat ? await this.readRaw(abs, stat) : null
    if (current === content) return
    await this.commitOutside()
    const target = await this.prepareParent(rel)
    await this.atomicWrite(target, content, {
      hash: current === null ? null : hashContent(current),
    })
    await this.commit([rel], `${stat ? 'Update' : 'Create'} ${rel}`, author, rel)
    await this.indexFile(rel, author)
    await this.publish({ path: rel, kind: 'written', to: null, by: author })
  }

  /** Fills "who last changed it" for notes the index has no author for yet, from git history. */
  private async fillAuthors(): Promise<void> {
    const authors = await this.git.lastAuthors()
    if (authors.size === 0) return
    this.options.db.tx((sqlite) => {
      const update = sqlite.prepare(
        'UPDATE knowledge_notes SET last_author = ? WHERE path = ? AND last_author IS NULL',
      )
      for (const [rel, column] of authors) update.run(column, rel)
    })
    this.docs.fillAuthors(authors)
  }

  /** Drops the index and rebuilds it from the files (it is disposable). */
  rebuild(): Promise<void> {
    return this.serial(async () => {
      this.options.db.tx((sqlite) => {
        sqlite.exec(
          'DELETE FROM knowledge_fts; DELETE FROM knowledge_links; DELETE FROM knowledge_notes; DELETE FROM knowledge_doc_fts; DELETE FROM knowledge_documents;',
        )
      })
      // Whether a document is versioned is git's to say, not the first-upload size policy.
      this.docs.trackedHint = await this.git.trackedPaths()
      try {
        await this.scan(false)
      } finally {
        this.docs.trackedHint = null
      }
      await this.fillAuthors()
    })
  }

  /** Runs one scan now (the watcher and the timer do this too). */
  scanNow(announce = true): Promise<string[]> {
    // An explicit scan checks content, not just (mtime, size).
    return this.serial(() => this.scan(announce, true))
  }

  // ---- reads -------------------------------------------------------------------------------------------------

  agentAccess(): boolean {
    const row = this.options.db.read((sqlite) =>
      sqlite.prepare('SELECT agent_access FROM knowledge_settings WHERE id = 1').get(),
    )
    return z.object({ agent_access: z.number() }).parse(row).agent_access === 1
  }

  /** Settings › Knowledge: "Save compacted summaries as memory notes". */
  memoryNotes(): boolean {
    const row = this.options.db.read((sqlite) =>
      sqlite.prepare('SELECT memory_notes FROM knowledge_settings WHERE id = 1').get(),
    )
    return z.object({ memory_notes: z.number() }).parse(row).memory_notes === 1
  }

  setMemoryNotes(value: boolean): KnowledgeInfo {
    this.options.db.tx((sqlite) =>
      sqlite
        .prepare('UPDATE knowledge_settings SET memory_notes = ? WHERE id = 1')
        .run(value ? 1 : 0),
    )
    return this.info()
  }

  setAgentAccess(value: boolean): KnowledgeInfo {
    this.options.db.tx((sqlite) =>
      sqlite
        .prepare('UPDATE knowledge_settings SET agent_access = ? WHERE id = 1')
        .run(value ? 1 : 0),
    )
    return this.info()
  }

  info(): KnowledgeInfo {
    const count = this.options.db.read(
      (sqlite) =>
        z
          .object({ count: z.number() })
          .parse(sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_notes').get()).count,
    )
    const documents = this.docs.stats()
    return {
      vault: this.root,
      notes: count,
      gitAvailable: this.git.available,
      agentAccess: this.agentAccess(),
      memoryNotes: this.memoryNotes(),
      documents: documents.documents,
      documentBytes: documents.bytes,
      moveIssue: this.issue,
    }
  }

  async tree(): Promise<KnowledgeTree> {
    const { folders } = await this.walk()
    const notes = this.options.db.read((sqlite) => this.noteRows(sqlite))
    return {
      folders,
      documents: this.docs.list(),
      notes: notes.map((row) => ({
        path: row.path,
        title: row.title,
        mtime: new Date(row.mtime_ms).toISOString(),
        lastAuthor: authorFromColumn(row.last_author),
      })),
    }
  }

  async readNote(input: string): Promise<KnowledgeNote> {
    const rel = parseNotePath(input)
    const { abs, stat } = await this.lookup(rel.split('/'))
    if (!stat) throw new HttpError(404, 'not_found', 'Couldn’t find that note.')
    let raw = await this.readRaw(abs, stat)
    let hash = hashContent(raw)
    let mtimeMs = stat.mtimeMs
    let row = this.options.db.read((sqlite) => this.noteRow(sqlite, rel))
    if (row?.hash !== hash) {
      // The file changed (or appeared) behind the scanner's back: index it now, and answer from the very version
      // that was indexed, so body, etag, title, links and author always belong together.
      const indexed = await this.serial(async () => {
        const result = await this.indexFile(rel, 'outside')
        await this.publish({ path: rel, kind: 'written', to: null, by: 'outside' })
        return result
      })
      ;({ raw, hash, mtimeMs } = indexed)
      row = this.options.db.read((sqlite) => this.noteRow(sqlite, rel))
    }
    if (!row) throw new HttpError(404, 'not_found', 'Couldn’t find that note.')
    const parsed = parseNote(raw)
    const { links, backlinks } = this.options.db.read((sqlite) => ({
      links: sqlite
        .prepare(
          'SELECT to_target, to_path FROM knowledge_links WHERE from_path = ? ORDER BY rowid',
        )
        .all(rel)
        .map((item) =>
          z.object({ to_target: z.string(), to_path: z.string().nullable() }).parse(item),
        )
        .map((item) => ({ target: item.to_target, path: item.to_path })),
      backlinks: sqlite
        .prepare(
          `SELECT DISTINCT n.path, n.title FROM knowledge_links l JOIN knowledge_notes n ON n.path = l.from_path
           WHERE l.to_path = ? AND l.from_path != ? ORDER BY n.path`,
        )
        .all(rel, rel)
        .map((item) => z.object({ path: z.string(), title: z.string() }).parse(item)),
    }))
    return {
      path: rel,
      title: row.title,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      etag: etagOf(hash),
      mtime: new Date(mtimeMs).toISOString(),
      links,
      backlinks,
      lastAuthor: authorFromColumn(row.last_author),
      ...(await this.historyOf(rel)),
    }
  }

  search(query: string, limit: number): KnowledgeSearchHit[] {
    // User text is never FTS syntax: only words survive, each quoted; the last word matches as a prefix.
    const words = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 12)
    if (words.length === 0) return []
    const match = words
      .map((word, index) => `"${word}"${index === words.length - 1 ? '*' : ''}`)
      .join(' ')
    const max = Math.min(Math.max(limit, 1), 50)
    try {
      const notes = this.options.db.read((sqlite) =>
        sqlite
          .prepare(
            `SELECT path, title, snippet(knowledge_fts, -1, '[[', ']]', '…', 16) AS snippet,
                    bm25(knowledge_fts, 0.0, 8.0, 1.0) AS rank
             FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY rank LIMIT ?`,
          )
          .all(match, max)
          .map((row) =>
            z
              .object({
                path: z.string(),
                title: z.string(),
                snippet: z.string(),
                rank: z.number(),
              })
              .parse(row),
          ),
      )
      const documents = this.docs.search(match, max)
      // bm25 is lower for better matches in both indexes; the two scales are close enough to interleave.
      return [
        ...notes.map((hit) => ({ ...hit, kind: 'note' as const, type: null })),
        ...documents.map((hit) => ({ ...hit, kind: 'document' as const })),
      ]
        .sort((a, b) => a.rank - b.rank)
        .slice(0, max)
        .map((hit) => ({
          path: hit.path,
          title: hit.title,
          snippet: hit.snippet,
          kind: hit.kind,
          type: hit.type,
        }))
    } catch {
      return []
    }
  }

  async history(input: string): Promise<KnowledgeCommit[]> {
    const rel = parseNotePath(input)
    const items = await this.serial(() => this.git.history(rel))
    return items.map((item) => ({
      commit: item.commit,
      at: item.at,
      author: item.author,
      message: item.message,
    }))
  }

  async version(input: string, commit: string): Promise<{ commit: string; body: string }> {
    const rel = parseNotePath(input)
    const raw = await this.serial(() => this.git.version(rel, commit))
    if (raw === null) throw new HttpError(404, 'not_found', 'Couldn’t find that version.')
    return { commit, body: parseNote(raw).body }
  }

  // ---- writes ------------------------------------------------------------------------------------------------

  /** Commits whatever changed behind Score's back before Score's own commit. */
  async commitOutside(): Promise<void> {
    try {
      await this.git.commitOutsideChanges()
    } catch (error) {
      // Without that snapshot an overwrite or delete could destroy an outside edit that never reached history.
      this.options.log?.warn(
        { err: error },
        'Could not record outside changes in the vault history',
      )
      throw new HttpError(
        503,
        'git_unavailable',
        'Knowledge history isn’t working (git failed), so notes can’t be changed safely. Fix the git repository in the Knowledge folder and try again.',
      )
    }
  }

  /** Commits paths for the documents module (same author and failure rules as notes). */
  async commitPaths(
    paths: string[],
    message: string,
    author: KnowledgeAuthor,
  ): Promise<HistoryOutcome> {
    return this.commit(paths, message, author)
  }

  get gitAvailable(): boolean {
    return this.git.available
  }

  /** The given paths that are Git-ignored and untracked (the documents module classifies with this). */
  ignoredUntracked(paths: string[]): Promise<Set<string>> {
    return this.git.ignoredUntracked(paths)
  }

  /** Indexes a note file Score has just written itself. */
  async indexNote(rel: string, author: KnowledgeAuthor): Promise<void> {
    await this.indexFile(rel, author)
  }

  /**
   * Commits what Score changed and says what happened to history. Ignored, untracked paths are left out (never
   * force-added, decision 80) and reported as `not_versioned`; a missing git is `git_unavailable`; any other git
   * failure is logged and reported as `failed`. The files are saved in every case. Calling it again for content that
   * is already in history answers `unchanged`; for content whose commit failed it commits (a repair).
   */
  private async commit(
    paths: string[],
    message: string,
    author: KnowledgeAuthor,
    amendNote?: string,
  ): Promise<HistoryOutcome> {
    if (!this.git.available) return historyOutcome('git_unavailable')
    try {
      const ignored = await this.git.ignoredUntracked(paths)
      const rest = paths.filter((path) => !ignored.has(path))
      if (rest.length === 0) return historyOutcome('not_versioned')
      const sha = await this.git.commit({
        paths: rest,
        message,
        author,
        ...(amendNote && !ignored.has(amendNote) ? { amendNote } : {}),
      })
      return historyOutcome(sha === null ? 'unchanged' : 'committed', ignored.size > 0)
    } catch (error) {
      // The files are saved; history can catch up with the next "Outside changes" commit.
      this.options.log?.warn({ err: error }, 'Could not commit a knowledge change')
      return historyOutcome('failed')
    }
  }

  /**
   * Where a note stands in history, as a read finds it: no working git is `git_unavailable` (never "versioned"); a
   * Git-ignored, untracked path is `not_versioned`; a file that differs from the last commit, or whose state Git can't tell, is `failed` (the editor
   * keeps offering "Save to history again" across a reload); otherwise the content is already in history.
   */
  private async historyOf(
    rel: string,
  ): Promise<{ versioned: boolean; history: KnowledgeHistoryStatus }> {
    if (!this.git.available) return { versioned: false, history: 'git_unavailable' }
    if ((await this.git.ignoredUntracked([rel])).has(rel))
      return { versioned: false, history: 'not_versioned' }
    // Unknown (Git itself failed) keeps `failed`: the retry stays on offer until history can be verified.
    return {
      versioned: true,
      history: (await this.git.pathState(rel)) === 'clean' ? 'unchanged' : 'failed',
    }
  }

  /** Save a note (create with `etag: null`). `author` is `'you'` for the browser; 6.4 passes the calling agent. */
  async writeNote(
    input: string,
    request: KnowledgeWriteRequest,
    author: KnowledgeAuthor = 'you',
    /** Uploads: `request.body` is the whole file (frontmatter included), written byte for byte. */
    rawContent = false,
  ): Promise<{ etag: string; path: string } & HistoryOutcome> {
    const rel = parseNotePath(input)
    return this.serial(async () => {
      const { abs: existingAbs, stat } = await this.lookup(rel.split('/'))
      let current: ReturnType<typeof parseNote> | null = null
      let currentHash: string | null = null
      if (stat) {
        const raw = await this.readRaw(existingAbs, stat)
        current = parseNote(raw)
        currentHash = hashContent(raw)
      }
      if (request.etag === null && stat)
        throw new HttpError(409, 'exists', 'A note with that name already exists.')
      if (request.etag !== null) {
        if (currentHash === null)
          throw new HttpError(412, 'precondition_failed', 'The note was removed.', { etag: null })
        if (etagOf(currentHash) !== request.etag)
          throw new HttpError(412, 'precondition_failed', 'The note changed after you opened it.', {
            etag: etagOf(currentHash),
          })
      }
      const content = rawContent
        ? request.body
        : request.frontmatter === undefined
          ? (current?.prefix ?? '') + request.body
          : serialiseNote(request.body, request.frontmatter)
      prepareNoteContent(content)
      const hash = hashContent(content)
      if (hash === currentHash) {
        // Nothing to write, but a commit that failed earlier is still owed: try it again before answering.
        const repaired = await this.commit([rel], `${stat ? 'Update' : 'Create'} ${rel}`, author)
        return { etag: etagOf(hash), path: rel, ...repaired }
      }
      await this.commitOutside()
      const abs = await this.prepareParent(rel)
      // An outside edit that landed since the etag check is now in history; the save must not silently replace it.
      await this.atomicWrite(abs, content, { hash: currentHash })
      const history = await this.commit([rel], `${stat ? 'Update' : 'Create'} ${rel}`, author, rel)
      await this.indexFile(rel, author)
      await this.publish({ path: rel, kind: 'written', to: null, by: author })
      // A memory note's weight or a new memory note changes its month's list (PLAN 8.2); the save stands either way.
      await this.refreshMemoryIndexes([rel], author)
      return { etag: etagOf(hash), path: rel, ...history }
    })
  }

  async moveNote(
    fromInput: string,
    toInput: string,
    updateLinks: boolean,
    author: KnowledgeAuthor = 'you',
  ): Promise<{ path: string; updatedNotes: number; skipped: MoveSkipped[] }> {
    const from = parseNotePath(fromInput)
    const to = parseNotePath(toInput)
    return this.serial(async () => {
      await this.recoverMove()
      if (this.issue !== null)
        throw new HttpError(
          409,
          'move_pending',
          this.issue.state === 'conflicted'
            ? 'An earlier move needs your attention first (see the notice on the Knowledge page).'
            : 'An earlier move is still being finished. Try again in a moment.',
        )
      const source = await this.lookup(from.split('/'))
      if (!source.stat?.isFile()) throw new HttpError(404, 'not_found', 'Couldn’t find that note.')
      if (from === to) throw new HttpError(409, 'exists', 'A note with that name already exists.')
      const target = await this.lookup(to.split('/'))
      if (target.stat) throw new HttpError(409, 'exists', 'A note with that name already exists.')
      await this.commitOutside()
      // Notes or links added outside Score since the last scan must take part in the rewrite.
      await this.scan(true)
      const paths = this.options.db.read((sqlite) => this.noteRows(sqlite).map((row) => row.path))
      const before = buildNoteIndex(paths)
      const after = buildNoteIndex([...paths.filter((item) => item !== from), to])
      const linking = updateLinks
        ? this.options.db.read((sqlite) =>
            sqlite
              .prepare('SELECT DISTINCT from_path FROM knowledge_links WHERE to_path = ?')
              .all(from)
              .map((row) => z.object({ from_path: z.string() }).parse(row).from_path),
          )
        : []
      // Work out every rewrite first: a result over the size limit must refuse the whole move, not leave a note
      // that opens with 413 behind.
      const plan: Array<{ now: string; content: string; baseHash: string }> = []
      for (const old of linking) {
        const file = await this.lookup(old.split('/'))
        if (!file.stat?.isFile()) continue
        const raw = await this.readRaw(file.abs, file.stat)
        const parsed = parseNote(raw)
        const result = rewriteLinks(parsed.body, old, from, to, before, after)
        if (result.count === 0) continue
        const content = parsed.prefix + result.text
        if (Buffer.byteLength(content) > MAX_NOTE_BYTES)
          throw new HttpError(
            413,
            'payload_too_large',
            `Updating the links in ${old} would make that note too large. Nothing was moved.`,
          )
        plan.push({ now: old === from ? to : old, content, baseHash: hashContent(raw) })
      }
      const abs = await this.prepareParent(to)
      const identity = await this.identityOf(source.abs)
      const movePlan: MovePlan = {
        from,
        to,
        author,
        state: 'active',
        identity,
        items: plan.map((item) => ({
          path: item.now,
          baseHash: item.baseHash,
          newHash: hashContent(item.content),
          content: item.content,
          done: false,
          skipped: false,
        })),
      }
      // Written before anything moves: if Score stops half way, the next start finishes (or drops) the rewrites.
      await this.savePlan(movePlan)
      try {
        const moved = await this.moveNoReplace(source.abs, abs)
        if (!moved.synced)
          this.options.log?.warn({ from, to }, 'Couldn’t flush the folders after a move')
      } catch (error) {
        // One atomic call: when it failed with a definite answer nothing moved and the plan ends. Anything else
        // (a killed helper, say) is settled by looking at the files, never by assuming.
        if (
          error instanceof HttpError &&
          (error.code === 'exists' ||
            error.code === 'not_found' ||
            error.code === 'rename_unsupported')
        )
          await this.clearPlan()
        else await this.recoverMove()
        throw error
      }
      // What was actually moved (the file may have been saved again after the plan was written): recovery compares
      // the destination with this, not with the older identity.
      try {
        movePlan.identity = await this.identityOf(abs, false)
        await this.savePlan(movePlan)
      } catch (error) {
        this.options.log?.warn({ err: error }, 'Couldn’t record the moved note’s identity')
      }
      await this.assertParent(path.dirname(abs))
      // The rename gets a commit of its own: with the link edits in the same commit a short note can look like a
      // delete plus a create to git, and its earlier versions would no longer be found.
      await this.commit([from, to], `Move ${from} to ${to}`, author)
      const done = await this.finishMove(movePlan)
      return { path: to, updatedNotes: done.updated, skipped: done.skipped }
    })
  }

  // ---- move plan (roll-forward recovery) ---------------------------------------------------------------------

  /**
   * In Score's own state, keyed by the vault's real path: never inside the vault, so it is not swept into a commit or
   * walked as a note, and it works whatever the vault's layout (a linked Git worktree's `.git` is a file).
   */
  private stateRoot(): string {
    return this.options.stateDir ?? path.join(os.tmpdir(), 'score-knowledge-state')
  }

  planFile(): string {
    const key = createHash('sha256').update(this.root).digest('hex').slice(0, 16)
    return path.join(this.stateRoot(), `move-plan-${key}.json`)
  }

  /** Reads the plan; null when there is none. Anything unreadable is reported to the caller as an error. */
  private async readPlan(file: string): Promise<MovePlan | null> {
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      throw error
    }
    return MovePlanSchema.parse(JSON.parse(raw))
  }

  /**
   * Moves a plan an older version kept under `.git` into Score's state: copy, confirm the copy is on disk and parses,
   * and only then delete the old file. Only content that can never be read (a parse error) is discarded; any I/O
   * error leaves the old file for the next start, so a plan always survives somewhere.
   */
  private async migrateLegacyPlan(): Promise<void> {
    const legacy = path.join(this.root, '.git', 'score-move-plan.json')
    let raw: string
    try {
      raw = await fs.readFile(legacy, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return // none, or `.git` is a file (linked worktree)
      throw error
    }
    let plan: MovePlan
    try {
      plan = MovePlanSchema.parse(JSON.parse(raw))
    } catch (error) {
      this.options.log?.warn({ err: error }, 'Discarded an unreadable move plan')
      await fs.rm(legacy, { force: true })
      return
    }
    const target = this.planFile()
    const [legacyStat, targetStat] = await Promise.all([
      fs.stat(legacy),
      fs.stat(target).catch((error: unknown) => {
        if (isNotFound(error)) return null
        throw error
      }),
    ])
    let keepLegacy = targetStat === null
    if (targetStat !== null) {
      // Both exist: the newer file wins. An unreadable replacement doesn't count as a plan.
      const existing = await this.readPlan(target).catch((error: unknown) => {
        if (error instanceof SyntaxError || error instanceof z.ZodError) return null
        throw error
      })
      keepLegacy = existing === null || legacyStat.mtimeMs > targetStat.mtimeMs
    }
    if (keepLegacy) {
      await this.writePlanFile(plan)
      const back = await this.readPlan(target)
      if (back === null || JSON.stringify(back) !== JSON.stringify(plan))
        throw new Error('The migrated move plan could not be read back')
    }
    await fs.rm(legacy, { force: true })
  }

  /**
   * Written and flushed (file, then folder) before the caller changes anything in the vault, and again after each
   * step, so a plan on disk is never behind the files. Where the platform can't flush a folder, the file still is.
   */
  private async writePlanFile(plan: MovePlan): Promise<void> {
    const dir = this.stateRoot()
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const file = this.planFile()
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await fs.open(temp, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(plan))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(temp, file)
    } catch (error) {
      await fs.rm(temp, { force: true })
      throw error
    }
    await syncDir(dir)
  }

  private async savePlan(plan: MovePlan): Promise<void> {
    await this.writePlanFile(plan)
  }

  private async clearPlan(): Promise<void> {
    await fs.rm(this.planFile(), { force: true })
    await syncDir(this.stateRoot()).catch(() => undefined)
  }

  /** Writes one planned rewrite if the note is still the planned version. */
  private async applyMoveItem(item: MovePlan['items'][number]): Promise<'written' | 'conflict'> {
    const file = await this.lookup(item.path.split('/'))
    const current = file.stat?.isFile()
      ? await this.readContained(file.abs).then(hashContent, () => null)
      : null
    if (current === item.newHash) return 'written'
    if (current !== item.baseHash) return 'conflict'
    try {
      await this.atomicWrite(file.abs, item.content, { hash: item.baseHash }, true)
    } catch (error) {
      if (error instanceof HttpError && error.status === 412) return 'conflict'
      throw error
    }
    return 'written'
  }

  /**
   * The part of a move after the rename: applies the planned link rewrites (a note edited since is left alone),
   * commits, indexes and announces. A failure keeps the plan on disk for `recoverMove`. Every rewrite that was
   * recorded as done is checked again first: a note deleted or edited since (while Score was down, say) becomes a
   * skipped item, never a reason to fail.
   */
  private async finishMove(plan: MovePlan): Promise<{ updated: number; skipped: MoveSkipped[] }> {
    const { from, to, author } = plan
    let failure: unknown
    try {
      for (const item of plan.items) {
        if (item.done) continue
        if ((await this.applyMoveItem(item)) === 'conflict') {
          this.options.log?.warn(
            { path: item.path },
            'A note changed while its links were being updated; its links were left as they are',
          )
          item.skipped = true
          item.reason = 'it changed while the links were being updated'
        }
        item.done = true
        await this.savePlan(plan)
      }
    } catch (error) {
      failure = error
    }
    for (const item of plan.items) {
      if (!item.done || item.skipped) continue
      const file = await this.lookup(item.path.split('/')).catch(() => null)
      const current = file?.stat?.isFile()
        ? await this.readContained(file.abs).then(hashContent, () => null)
        : null
      if (current === item.newHash) continue
      item.skipped = true
      item.reason = current === null ? 'it was removed' : 'it changed since the links were updated'
    }
    const rewritten = plan.items
      .filter((item) => item.done && !item.skipped)
      .map((item) => item.path)
    if (rewritten.length > 0)
      await this.commit([...new Set(rewritten)], `Update links after moving ${from}`, author)
    this.options.db.tx((sqlite) => this.remove(sqlite, from))
    await this.indexFile(to, author).catch((error: unknown) => {
      // The moved note was removed or replaced by something that isn't a note since; the next scan sorts it out.
      this.options.log?.warn({ err: error, path: to }, 'Couldn’t index a moved note')
    })
    for (const rel of rewritten) if (rel !== to) await this.indexFile(rel, author)
    await this.publish({ path: from, kind: 'moved', to, by: author })
    for (const rel of rewritten)
      if (rel !== to) await this.publish({ path: rel, kind: 'written', to: null, by: author })
    if (failure !== undefined) {
      this.options.log?.warn({ err: failure }, 'Updating links after a move failed; it will resume')
      throw new HttpError(
        500,
        'move_incomplete',
        `The note was moved, but some links in other notes could not be updated yet. Score finishes this on its next start or move.`,
      )
    }
    await this.clearPlan()
    return {
      updated: rewritten.filter((rel) => rel !== to).length,
      skipped: plan.items
        .filter((item) => item.skipped)
        .map((item) => ({ path: item.path, reason: item.reason ?? 'it changed' })),
    }
  }

  /** Identity of the file at `abs`: inode and birth time survive a rename, the content hash survives a copy. */
  private async identityOf(abs: string, withHash = true): Promise<FileIdentity> {
    const st = await fs.lstat(abs)
    const hash = withHash ? await this.hashContained(abs, MAX_STORE_BYTES) : undefined
    return {
      dev: st.dev,
      ino: st.ino,
      birthtimeMs: st.birthtimeMs,
      size: st.size,
      ...(hash === undefined ? {} : { hash }),
    }
  }

  /** Whether the file at `abs` is the one `identity` describes. */
  private async matchesIdentity(abs: string, identity: FileIdentity): Promise<boolean> {
    const st = await fs.lstat(abs).catch(() => null)
    if (!st?.isFile()) return false
    if (
      st.dev === identity.dev &&
      st.ino === identity.ino &&
      st.birthtimeMs === identity.birthtimeMs
    )
      return true
    if (identity.hash === undefined || st.size !== identity.size) return false
    const hash = await this.hashContained(abs, MAX_STORE_BYTES).catch(() => null)
    return hash !== null && hash === identity.hash
  }

  /** The move that needs attention, for the Knowledge page. */
  moveIssue(): MoveIssue | null {
    return this.issue
  }

  /** Owner decision: abandon a conflicted (or stuck) plan. The files are left exactly as they are. */
  async dismissMoveIssue(): Promise<void> {
    return this.serial(async () => {
      await this.clearPlan()
      this.setIssue(null)
    })
  }

  private setIssue(issue: MoveIssue | null): void {
    this.issue = issue
    if (issue?.state !== 'pending') {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
      this.retryDelayMs = this.options.moveRetryMs ?? 2000
    }
  }

  private scheduleRecoveryRetry(): void {
    if (this.closed || this.retryTimer !== undefined) return
    const delay = this.retryDelayMs
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 5 * 60_000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.serial(() => this.recoverMove()).catch(() => undefined)
    }, delay)
    this.retryTimer.unref()
  }

  /**
   * Finishes a move that was interrupted after its plan was saved (caller holds the lock). Never throws, and the plan
   * only ends when the move is finished, was abandoned by the owner, or is proven untouched. A transient failure keeps
   * the plan, shows "move pending" and retries with backoff; a conflict keeps it and shows that instead; a plan that
   * can't be parsed is set aside as `.bad`.
   */
  private async recoverMove(): Promise<void> {
    try {
      await this.recoverMoveUnsafe()
    } catch (error) {
      this.options.log?.warn(
        { err: error },
        'Couldn’t finish an interrupted move; it will be retried',
      )
      const plan = await this.readPlan(this.planFile()).catch(() => null)
      if (plan === null) return
      this.setIssue({
        state: 'pending',
        from: plan.from,
        to: plan.to,
        message: 'A move is waiting to be finished; Score retries automatically.',
      })
      this.scheduleRecoveryRetry()
    }
  }

  private async recoverMoveUnsafe(): Promise<void> {
    let plan: MovePlan | null
    try {
      plan = await this.readPlan(this.planFile())
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error
      // Malformed: keep it for inspection, but it can't block Knowledge.
      this.options.log?.warn({ err: error }, 'Set aside an unreadable move plan')
      await fs.rename(this.planFile(), `${this.planFile()}.bad`)
      await syncDir(this.stateRoot()).catch(() => undefined)
      this.setIssue(null)
      return
    }
    if (plan === null) {
      this.setIssue(null)
      return
    }
    const conflict = async (detail: string): Promise<void> => {
      plan.state = 'conflicted'
      plan.detail = detail
      await this.savePlan(plan)
      this.options.log?.warn({ from: plan.from, to: plan.to, detail }, 'A move needs attention')
      this.setIssue({ state: 'conflicted', from: plan.from, to: plan.to, message: detail })
    }
    if (plan.state === 'conflicted') {
      this.setIssue({
        state: 'conflicted',
        from: plan.from,
        to: plan.to,
        message: plan.detail ?? 'An interrupted move could not be verified.',
      })
      return
    }
    if (plan.parked !== undefined) {
      await conflict(
        `A move from an older version of Score was interrupted. Look for a file named ${plan.parked} before dismissing this.`,
      )
      return
    }
    const target = await this.lookup(plan.to.split('/'))
    if (!target.stat) {
      // The rename is one atomic call and the destination was never created: nothing moved.
      await this.clearPlan()
      this.setIssue(null)
      return
    }
    const source = await this.lookup(plan.from.split('/'))
    const identity = plan.identity
    const targetIsMoved =
      identity === undefined ? !source.stat : await this.matchesIdentity(target.abs, identity)
    if (!targetIsMoved) {
      if (
        identity !== undefined &&
        source.stat &&
        (await this.matchesIdentity(source.abs, identity))
      ) {
        await this.clearPlan() // untouched: someone else's file sits at the destination
        this.setIssue(null)
        return
      }
      await conflict(
        `Score was moving ${plan.from} to ${plan.to}, but the file now at ${plan.to} is not the one that was being moved. Nothing was changed; check both names, then dismiss this.`,
      )
      return
    }
    this.setIssue(null)
    await this.commit([plan.from, plan.to], `Move ${plan.from} to ${plan.to}`, plan.author)
    await this.finishMove(plan)
  }

  /** A new, empty folder (git does not track empty folders; the tree lists it from the disk). */
  async createFolder(input: string): Promise<{ path: string }> {
    const segments = parseVaultPath(input)
    if (segments.some((segment) => segment.startsWith('.')))
      throw new HttpError(400, 'bad_path', 'Hidden files and folders are not part of Knowledge.')
    return this.serial(async () => {
      const { stat } = await this.lookup(segments)
      if (stat) throw new HttpError(409, 'exists', 'That name already exists.')
      await this.prepareParent(segments.join('/'))
      await fs.mkdir(path.join(this.root, ...segments))
      await this.publish({ path: segments.join('/'), kind: 'written', to: null, by: 'you' })
      return { path: segments.join('/') }
    })
  }

  /** Removes a folder only when nothing is in it. */
  async deleteFolder(input: string): Promise<void> {
    const segments = parseVaultPath(input)
    return this.serial(async () => {
      const { abs, stat } = await this.lookup(segments)
      if (!stat?.isDirectory()) throw new HttpError(404, 'not_found', 'Couldn’t find that folder.')
      if ((await fs.readdir(abs)).length > 0)
        throw new HttpError(409, 'not_empty', 'The folder isn’t empty.')
      await fs.rmdir(abs)
      await this.publish({ path: segments.join('/'), kind: 'deleted', to: null, by: 'you' })
    })
  }

  /** Owner only: agents have no delete. */
  async deleteNote(input: string, author: KnowledgeAuthor = 'you'): Promise<void> {
    const rel = parseNotePath(input)
    return this.serial(async () => {
      const { abs, stat } = await this.lookup(rel.split('/'))
      if (!stat?.isFile()) throw new HttpError(404, 'not_found', 'Couldn’t find that note.')
      await this.commitOutside()
      await fs.unlink(abs)
      await this.commit([rel], `Delete ${rel}`, author)
      this.options.db.tx((sqlite) => {
        this.remove(sqlite, rel)
        this.relink(sqlite)
      })
      await this.publish({ path: rel, kind: 'deleted', to: null, by: author })
    })
  }

  /** Writes the version at `commit` back as a new commit (history is never rewritten). */
  async restoreNote(
    input: string,
    commit: string,
    author: KnowledgeAuthor = 'you',
  ): Promise<{ etag: string; path: string }> {
    const rel = parseNotePath(input)
    return this.serial(async () => {
      const raw = await this.git.version(rel, commit)
      if (raw === null) throw new HttpError(404, 'not_found', 'Couldn’t find that version.')
      if (Buffer.byteLength(raw) > MAX_NOTE_BYTES)
        throw new HttpError(413, 'payload_too_large', 'That version is too large.')
      const { stat } = await this.lookup(rel.split('/'))
      if (stat && !stat.isFile()) throw new HttpError(400, 'not_a_note', 'That isn’t a note.')
      await this.commitOutside()
      const abs = await this.prepareParent(rel)
      await this.atomicWrite(abs, raw)
      await this.commit([rel], `Restore ${rel} to ${commit.slice(0, 7)}`, author)
      const { hash } = await this.indexFile(rel, author)
      await this.publish({ path: rel, kind: 'restored', to: null, by: author })
      return { etag: etagOf(hash), path: rel }
    })
  }
}
