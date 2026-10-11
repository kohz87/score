import { randomUUID } from 'node:crypto'
import { constants as C } from 'node:fs'
import { watch, type FSWatcher, type Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type {
  KnowledgeAuthor,
  KnowledgeChanged,
  KnowledgeCommit,
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
import { forIndex, validateNoteImages } from './note-images.ts'
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
import { isDocumentPath } from './doc-types.ts'
import { KnowledgeDocuments } from './documents.ts'

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
    }),
  ),
})
type MovePlan = z.infer<typeof MovePlanSchema>

const READ_CHUNK_BYTES = 256 * 1024
const MAX_FILES = 100_000
const MAX_DEPTH = 32
const MAX_EVENTS_PER_SCAN = 200
const README = `# Knowledge

Notes shared by you and your agents. Plain Markdown files with optional frontmatter; link notes with [[wikilinks]].
Every save is a git commit, so nothing is ever lost.
`

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
  /** Paths the watcher reported since the last scan. */
  private dirty = new Set<string>()
  private verifyNext = false

  constructor(private readonly options: VaultOptions) {
    this.root = path.resolve(options.vault)
    this.now = options.now ?? Date.now
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
        throw new HttpError(400, 'bad_path', 'Links inside the vault are not followed')
      const last = index === segments.length - 1
      if (!last && !stat.isDirectory())
        throw new HttpError(400, 'bad_path', 'A file is in the way of that folder')
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
      throw new HttpError(400, 'bad_path', 'The folder resolves outside the expected place')
  }

  /** `expect`: the content hash the target must still have (null = must not exist) right before it is replaced. */
  async atomicWrite(
    abs: string,
    content: string | Uint8Array,
    expect?: { hash: string | null },
  ): Promise<void> {
    const parent = path.dirname(abs)
    const temp = path.join(parent, `.score-${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temp, content, { flag: 'wx', mode: 0o644 })
      await this.assertParent(parent)
      if (expect) {
        const now = await this.readContained(abs).then(hashContent, () => null)
        if (now !== expect.hash)
          throw new HttpError(412, 'precondition_failed', 'The note changed since you opened it', {
            etag: now === null ? null : etagOf(now),
          })
      }
      if (expect?.hash === null) await this.moveNoReplace(temp, abs)
      else await fs.rename(temp, abs)
      await this.assertParent(parent)
    } catch (error) {
      await fs.rm(temp, { force: true })
      throw error
    }
  }

  /**
   * Moves `source` to `dest`, failing with 409 instead of replacing anything that appears there: the file is
   * hard-linked (which never replaces) and only then is the old name removed. Where hard links are unsupported
   * it falls back to a check followed by a rename.
   */
  async moveNoReplace(source: string, dest: string): Promise<void> {
    try {
      await fs.link(source, dest)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST')
        throw new HttpError(409, 'exists', 'A file with that name already exists')
      if (code !== 'EPERM' && code !== 'ENOSYS' && code !== 'EOPNOTSUPP') throw error
      if (
        await fs.lstat(dest).then(
          () => true,
          () => false,
        )
      )
        throw new HttpError(409, 'exists', 'A file with that name already exists')
      await fs.rename(source, dest)
      return
    }
    await fs.unlink(source)
  }

  /**
   * Reads a file that must live at exactly `abs` inside the vault: opened without following a symlink in the last
   * component, and on Linux the open descriptor's real path must still be `abs`, so a folder swapped for a symlink
   * after the path was checked cannot make Score read (and index) a file elsewhere.
   */
  private async readContained(abs: string): Promise<string> {
    return (await this.readContainedBuffer(abs)).toString('utf8')
  }

  /** `maxBytes` is checked on the open descriptor and while reading, so a file that grows after the size check cannot be slurped whole. */
  async readContainedBuffer(abs: string, maxBytes = MAX_NOTE_BYTES): Promise<Buffer> {
    const handle = await fs.open(abs, C.O_RDONLY | C.O_NOFOLLOW)
    try {
      if (process.platform === 'linux') {
        const actual = await fs.realpath(`/proc/self/fd/${handle.fd}`)
        if (actual !== abs)
          throw new HttpError(400, 'bad_path', 'The note moved while it was being read')
      }
      const tooLarge = () =>
        new HttpError(413, 'payload_too_large', 'That file is too large to open')
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

  private async readRaw(abs: string, stat: Stats): Promise<string> {
    if (!stat.isFile()) throw new HttpError(400, 'not_a_note', 'That is not a note')
    if (stat.size > MAX_NOTE_BYTES)
      throw new HttpError(413, 'payload_too_large', 'That note is too large to open')
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
    if (!stat?.isFile()) throw new HttpError(404, 'not_found', 'Unknown note')
    if (stat.size > MAX_NOTE_BYTES)
      throw new HttpError(413, 'payload_too_large', 'That note is too large to open')
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
    /** Folders (relative; '' = the whole vault) whose contents could not be fully listed. */
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
          } catch {
            // vanished between readdir and stat
          }
        } else if (entry.isFile() && isDocumentPath(entry.name)) {
          if (documents.size >= MAX_FILES) {
            incomplete.add('')
            continue
          }
          try {
            const stat = await fs.lstat(path.join(dir, entry.name))
            documents.set(childRel, { mtimeMs: stat.mtimeMs, size: stat.size })
          } catch {
            // vanished between readdir and stat
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
      await this.scan(false)
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
      documents: documents.documents,
      documentBytes: documents.bytes,
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
    if (!stat) throw new HttpError(404, 'not_found', 'Unknown note')
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
    if (!row) throw new HttpError(404, 'not_found', 'Unknown note')
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
    if (raw === null) throw new HttpError(404, 'not_found', 'Unknown version')
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
        'The vault history is not working (git failed), so notes cannot be changed safely. Fix the vault repository and try again.',
      )
    }
  }

  /** Commits paths for the documents module (same author and failure rules as notes). */
  commitPaths(paths: string[], message: string, author: KnowledgeAuthor): Promise<void> {
    return this.commit(paths, message, author)
  }

  /** Indexes a note file Score has just written itself. */
  async indexNote(rel: string, author: KnowledgeAuthor): Promise<void> {
    await this.indexFile(rel, author)
  }

  private async commit(
    paths: string[],
    message: string,
    author: KnowledgeAuthor,
    amendNote?: string,
  ): Promise<void> {
    try {
      await this.git.commit({ paths, message, author, ...(amendNote ? { amendNote } : {}) })
    } catch (error) {
      // The files are saved; history can catch up with the next "Outside changes" commit.
      this.options.log?.warn({ err: error }, 'Could not commit a knowledge change')
    }
  }

  /** Save a note (create with `etag: null`). `author` is `'you'` for the browser; 6.4 passes the calling agent. */
  async writeNote(
    input: string,
    request: KnowledgeWriteRequest,
    author: KnowledgeAuthor = 'you',
    /** Uploads: `request.body` is the whole file (frontmatter included), written byte for byte. */
    rawContent = false,
  ): Promise<{ etag: string; path: string }> {
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
        throw new HttpError(409, 'exists', 'A note with that name already exists')
      if (request.etag !== null) {
        if (currentHash === null)
          throw new HttpError(412, 'precondition_failed', 'The note was removed', { etag: null })
        if (etagOf(currentHash) !== request.etag)
          throw new HttpError(412, 'precondition_failed', 'The note changed since you opened it', {
            etag: etagOf(currentHash),
          })
      }
      const content = rawContent
        ? request.body
        : request.frontmatter === undefined
          ? (current?.prefix ?? '') + request.body
          : serialiseNote(request.body, request.frontmatter)
      if (Buffer.byteLength(content) > MAX_NOTE_BYTES)
        throw new HttpError(413, 'payload_too_large', 'That note is too large')
      validateNoteImages(content)
      const hash = hashContent(content)
      if (hash === currentHash) return { etag: etagOf(hash), path: rel }
      await this.commitOutside()
      const abs = await this.prepareParent(rel)
      // An outside edit that landed since the etag check is now in history; the save must not silently replace it.
      await this.atomicWrite(abs, content, { hash: currentHash })
      await this.commit([rel], `${stat ? 'Update' : 'Create'} ${rel}`, author, rel)
      await this.indexFile(rel, author)
      await this.publish({ path: rel, kind: 'written', to: null, by: author })
      return { etag: etagOf(hash), path: rel }
    })
  }

  async moveNote(
    fromInput: string,
    toInput: string,
    updateLinks: boolean,
    author: KnowledgeAuthor = 'you',
  ): Promise<{ path: string; updatedNotes: number }> {
    const from = parseNotePath(fromInput)
    const to = parseNotePath(toInput)
    return this.serial(async () => {
      await this.recoverMove()
      const source = await this.lookup(from.split('/'))
      if (!source.stat?.isFile()) throw new HttpError(404, 'not_found', 'Unknown note')
      if (from === to) throw new HttpError(409, 'exists', 'A note with that name already exists')
      const target = await this.lookup(to.split('/'))
      if (target.stat) throw new HttpError(409, 'exists', 'A note with that name already exists')
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
            `Updating the links in ${old} would make that note too large; nothing was moved`,
          )
        plan.push({ now: old === from ? to : old, content, baseHash: hashContent(raw) })
      }
      const abs = await this.prepareParent(to)
      const movePlan: MovePlan = {
        from,
        to,
        author,
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
        await this.moveNoReplace(source.abs, abs)
        await this.assertParent(path.dirname(abs))
      } catch (error) {
        await this.clearPlan()
        throw error
      }
      // The rename gets a commit of its own: with the link edits in the same commit a short note can look like a
      // delete plus a create to git, and its earlier versions would no longer be found.
      await this.commit([from, to], `Move ${from} to ${to}`, author)
      return { path: to, updatedNotes: await this.finishMove(movePlan) }
    })
  }

  // ---- move plan (roll-forward recovery) ---------------------------------------------------------------------

  /** Inside `.git`, so it is never swept into a commit or walked as a note. Null when the vault has no `.git`. */
  private planFile(): string {
    return path.join(this.root, '.git', 'score-move-plan.json')
  }

  private async savePlan(plan: MovePlan): Promise<void> {
    const file = this.planFile()
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temp, JSON.stringify(plan), { mode: 0o600 })
      await fs.rename(temp, file)
    } catch (error) {
      await fs.rm(temp, { force: true })
      // Without a `.git` folder (git unavailable) there is nowhere to keep the plan; the move still proceeds.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async clearPlan(): Promise<void> {
    await fs.rm(this.planFile(), { force: true })
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
      await this.atomicWrite(file.abs, item.content, { hash: item.baseHash })
    } catch (error) {
      if (error instanceof HttpError && error.status === 412) return 'conflict'
      throw error
    }
    return 'written'
  }

  /**
   * The part of a move after the rename: applies the planned link rewrites (a note edited since is left alone),
   * commits, indexes and announces. A failure keeps the plan on disk for `recoverMove`.
   */
  private async finishMove(plan: MovePlan): Promise<number> {
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
        }
        item.done = true
        await this.savePlan(plan)
      }
    } catch (error) {
      failure = error
    }
    const rewritten = plan.items
      .filter((item) => item.done && !item.skipped)
      .map((item) => item.path)
    if (rewritten.length > 0)
      await this.commit([...new Set(rewritten)], `Update links after moving ${from}`, author)
    this.options.db.tx((sqlite) => this.remove(sqlite, from))
    await this.indexFile(to, author)
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
    return rewritten.filter((rel) => rel !== to).length
  }

  /** Finishes a move that was interrupted after its plan was saved (caller holds the lock). */
  private async recoverMove(): Promise<void> {
    let plan: MovePlan
    try {
      plan = MovePlanSchema.parse(JSON.parse(await fs.readFile(this.planFile(), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.options.log?.warn({ err: error }, 'Ignored an unreadable move plan')
      await this.clearPlan()
      return
    }
    const source = await this.lookup(plan.from.split('/'))
    const target = await this.lookup(plan.to.split('/'))
    if (source.stat && target.stat) {
      // Linked but not yet unlinked: the same file under both names finishes the move; anything else is not ours.
      if (source.stat.ino !== target.stat.ino || source.stat.dev !== target.stat.dev) {
        await this.clearPlan()
        return
      }
      await fs.unlink(source.abs)
    } else if (!target.stat) {
      await this.clearPlan() // the move never happened
      return
    }
    await this.commit([plan.from, plan.to], `Move ${plan.from} to ${plan.to}`, plan.author)
    await this.finishMove(plan)
  }

  /** A new, empty folder (git does not track empty folders; the tree lists it from the disk). */
  async createFolder(input: string): Promise<{ path: string }> {
    const segments = parseVaultPath(input)
    if (segments.some((segment) => segment.startsWith('.')))
      throw new HttpError(400, 'bad_path', 'Hidden files and folders are not part of the vault')
    return this.serial(async () => {
      const { stat } = await this.lookup(segments)
      if (stat) throw new HttpError(409, 'exists', 'That name already exists')
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
      if (!stat?.isDirectory()) throw new HttpError(404, 'not_found', 'Unknown folder')
      if ((await fs.readdir(abs)).length > 0)
        throw new HttpError(409, 'not_empty', 'The folder is not empty')
      await fs.rmdir(abs)
      await this.publish({ path: segments.join('/'), kind: 'deleted', to: null, by: 'you' })
    })
  }

  /** Owner only: agents have no delete. */
  async deleteNote(input: string, author: KnowledgeAuthor = 'you'): Promise<void> {
    const rel = parseNotePath(input)
    return this.serial(async () => {
      const { abs, stat } = await this.lookup(rel.split('/'))
      if (!stat?.isFile()) throw new HttpError(404, 'not_found', 'Unknown note')
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
      if (raw === null) throw new HttpError(404, 'not_found', 'Unknown version')
      if (Buffer.byteLength(raw) > MAX_NOTE_BYTES)
        throw new HttpError(413, 'payload_too_large', 'That version is too large')
      const { stat } = await this.lookup(rel.split('/'))
      if (stat && !stat.isFile()) throw new HttpError(400, 'not_a_note', 'That is not a note')
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
