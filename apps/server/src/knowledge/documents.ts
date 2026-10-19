import type { ReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type {
  KnowledgeAuthor,
  KnowledgeDocument,
  KnowledgeDocumentSummary,
  KnowledgeDocumentType,
  KnowledgeHistoryStatus,
  KnowledgeUnzipResult,
  KnowledgeUploadResult,
  KnowledgeZipPreview,
} from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { KnowledgeTextStatusSchema } from '@score/contract'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'
import { isPlainText } from '../media/sniff.ts'
import { bigFileMatches } from './big-file.ts'
import { prepareNoteContent } from './note-images.ts'
import { redact } from '../redact.ts'
import {
  bytesMatch,
  classifyName,
  documentTypeOfPath,
  MAX_READ_BYTES,
  MAX_STORE_BYTES,
  MAX_TEXT_BYTES,
  MAX_VERSIONED_BYTES,
  PLAIN_TEXT_TYPES,
  WORKER_TEXT_TYPES,
} from './doc-types.ts'
import {
  extractDocumentText,
  runWorker,
  ZIP_LIMITS,
  ZIP_TIMEOUT_MS,
  zipFailure,
} from './extract.ts'
import {
  authorFromColumn,
  authorToColumn,
  hashContent,
  MAX_NOTE_BYTES,
  parseVaultPath,
} from './note.ts'
import type { KnowledgeVault } from './vault.ts'

type TextStatus = z.infer<typeof KnowledgeTextStatusSchema>

const DocRowSchema = z.object({
  id: z.number(),
  path: z.string(),
  type: z.enum(['pdf', 'docx', 'csv', 'json', 'html', 'image', 'zip']),
  mtime_ms: z.number(),
  size: z.number(),
  hash: z.string(),
  versioned: z.number(),
  text_status: KnowledgeTextStatusSchema,
  entries_json: z.string().nullable(),
  last_author: z.string().nullable(),
})
type DocRow = z.infer<typeof DocRowSchema>
const EntriesSchema = z.array(z.object({ path: z.string(), size: z.number() }))
const MAX_EVENTS = 200

export type OnConflict = 'ask' | 'keep' | 'replace'

interface PreparedDocument {
  kind: 'document'
  path: string
  type: KnowledgeDocumentType
  bytes: Buffer
  text: string
  status: TextStatus
  entries: Array<{ path: string; size: number }> | null
}
interface PreparedNote {
  kind: 'note'
  path: string
  bytes: Buffer
}
type Prepared = PreparedDocument | PreparedNote
/** An unzipped file waiting to be placed: its bytes stay in the scratch folder (`facts` null = a note). */
interface Unpacked {
  path: string
  file: string
  facts: Omit<PreparedDocument, 'bytes'> | null
}
const withoutBytes = (document: PreparedDocument): Omit<PreparedDocument, 'bytes'> => ({
  kind: 'document',
  path: document.path,
  type: document.type,
  text: document.text,
  status: document.status,
  entries: document.entries,
})

const toSummary = (row: DocRow): KnowledgeDocumentSummary => ({
  path: row.path,
  type: row.type,
  size: row.size,
  mtime: new Date(row.mtime_ms).toISOString(),
  lastAuthor: authorFromColumn(row.last_author),
  versioned: row.versioned === 1,
  textStatus: row.text_status,
})

/** Free name for `keep both`: `report.pdf` -> `report (2).pdf`. */
function suffixed(rel: string, n: number): string {
  const dir = path.posix.dirname(rel)
  const base = path.posix.basename(rel)
  const dot = base.lastIndexOf('.')
  const name = dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})`
  return dir === '.' ? name : `${dir}/${name}`
}

function cleanSegments(input: string): string[] {
  const segments = parseVaultPath(input)
  if (segments.some((segment) => segment.startsWith('.')))
    throw new HttpError(400, 'bad_path', 'Hidden files and folders are not part of Knowledge.')
  return segments
}

/**
 * Uploaded documents in the vault (PLAN 6.6): PDF, DOCX, CSV, JSON, HTML, images and zips next to the Markdown notes.
 * The files are the truth; the DB rows and the FTS text are an index. All changes run through the vault's lock.
 */
type IngestOutcome = 'unchanged' | 'upserted' | 'removed' | 'unreadable'

export class KnowledgeDocuments {
  /** Paths git tracks, set only while the vault rebuilds the index; null otherwise. */
  trackedHint: Set<string> | null = null

  constructor(
    private readonly vault: KnowledgeVault,
    private readonly db: ScoreDb,
  ) {}

  // ---- rows ------------------------------------------------------------------------------------------------

  private rows(sqlite: DatabaseSync): DocRow[] {
    return sqlite
      .prepare('SELECT * FROM knowledge_documents ORDER BY path')
      .all()
      .map((row) => DocRowSchema.parse(row))
  }
  private row(sqlite: DatabaseSync, rel: string): DocRow | undefined {
    const row = sqlite.prepare('SELECT * FROM knowledge_documents WHERE path = ?').get(rel)
    return row === undefined ? undefined : DocRowSchema.parse(row)
  }

  list(): KnowledgeDocumentSummary[] {
    return this.db.read((sqlite) => this.rows(sqlite)).map(toSummary)
  }

  /**
   * Startup repair of the `versioned` flag: rows written before documents followed the ignore rule can say "in git"
   * for a Git-ignored, untracked path (its commit was never possible), or "not in git" for a small file whose ignore
   * rule is gone. A tracked file always keeps history, and nothing is force-added.
   */
  async reconcileHistory(): Promise<number> {
    if (!this.vault.gitAvailable) return 0
    const rows = this.db.read((sqlite) => this.rows(sqlite))
    const ask = rows.filter((row) => row.versioned === 1 || row.size <= MAX_VERSIONED_BYTES)
    if (ask.length === 0) return 0
    const ignored = await this.vault.ignoredUntracked(ask.map((row) => row.path))
    const fix = ask.filter((row) =>
      row.versioned === 1 ? ignored.has(row.path) : !ignored.has(row.path),
    )
    if (fix.length === 0) return 0
    this.db.tx((sqlite) => {
      const update = sqlite.prepare('UPDATE knowledge_documents SET versioned = ? WHERE path = ?')
      for (const row of fix) update.run(row.versioned === 1 ? 0 : 1, row.path)
    })
    return fix.length
  }

  /** Paths that are stored but not in git (the vault's git must not sweep them into "Outside changes"). */
  unversionedPaths(): string[] {
    return this.db.read((sqlite) =>
      sqlite
        .prepare('SELECT path FROM knowledge_documents WHERE versioned = 0')
        .all()
        .map((row) => z.object({ path: z.string() }).parse(row).path),
    )
  }

  stats(): { documents: number; bytes: number } {
    return this.db.read((sqlite) =>
      z
        .object({ documents: z.number(), bytes: z.number() })
        .parse(
          sqlite
            .prepare(
              'SELECT COUNT(*) AS documents, COALESCE(SUM(size), 0) AS bytes FROM knowledge_documents',
            )
            .get(),
        ),
    )
  }

  private writeIndex(
    sqlite: DatabaseSync,
    rel: string,
    file: { mtimeMs: number; size: number; hash: string; versioned: boolean },
    document: Pick<PreparedDocument, 'type' | 'text' | 'status' | 'entries'>,
    author: KnowledgeAuthor | null,
  ): void {
    const existing = this.row(sqlite, rel)
    const column = author === null ? (existing?.last_author ?? null) : authorToColumn(author)
    const entries = document.entries ? JSON.stringify(document.entries) : null
    let id: number
    if (existing) {
      id = existing.id
      sqlite
        .prepare(
          `UPDATE knowledge_documents SET type = ?, mtime_ms = ?, size = ?, hash = ?, versioned = ?, text_status = ?,
           entries_json = ?, last_author = ? WHERE id = ?`,
        )
        .run(
          document.type,
          Math.trunc(file.mtimeMs),
          file.size,
          file.hash,
          file.versioned ? 1 : 0,
          document.status,
          entries,
          column,
          id,
        )
    } else {
      id = Number(
        sqlite
          .prepare(
            `INSERT INTO knowledge_documents (path, type, mtime_ms, size, hash, versioned, text_status, entries_json, last_author)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            rel,
            document.type,
            Math.trunc(file.mtimeMs),
            file.size,
            file.hash,
            file.versioned ? 1 : 0,
            document.status,
            entries,
            column,
          ).lastInsertRowid,
      )
    }
    sqlite.prepare('DELETE FROM knowledge_doc_fts WHERE rowid = ?').run(id)
    if (document.status === 'indexed' || document.status === 'truncated')
      sqlite
        .prepare('INSERT INTO knowledge_doc_fts (rowid, path, title, body) VALUES (?, ?, ?, ?)')
        .run(id, rel, path.posix.basename(rel), document.text)
  }

  private removeIndex(sqlite: DatabaseSync, rel: string): void {
    const existing = this.row(sqlite, rel)
    if (!existing) return
    sqlite.prepare('DELETE FROM knowledge_doc_fts WHERE rowid = ?').run(existing.id)
    sqlite.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(existing.id)
  }

  private textOf(sqlite: DatabaseSync, id: number): string {
    const row = sqlite.prepare('SELECT body FROM knowledge_doc_fts WHERE rowid = ?').get(id)
    return row === undefined ? '' : z.object({ body: z.string() }).parse(row).body
  }

  // ---- reading ---------------------------------------------------------------------------------------------

  isDocument(rel: string): boolean {
    return this.db.read((sqlite) => this.row(sqlite, rel) !== undefined)
  }

  /** One document with its extracted text; reconciles with the disk first so an outside change shows. */
  async get(input: string): Promise<KnowledgeDocument> {
    const rel = this.knownPath(input)
    const row = await this.reconcile(rel)
    const text = this.db.read((sqlite) => this.textOf(sqlite, row.id))
    return {
      ...toSummary(row),
      text,
      entries: row.entries_json ? EntriesSchema.parse(JSON.parse(row.entries_json)) : null,
    }
  }

  private knownPath(input: string): string {
    const segments = cleanSegments(input)
    const rel = segments.join('/')
    if (documentTypeOfPath(rel) === null)
      throw new HttpError(400, 'not_a_document', 'That isn’t a document.')
    return rel
  }

  /** The document's row, after indexing a change that happened behind the scanner's back. */
  private async reconcile(rel: string): Promise<DocRow> {
    const { stat } = await this.vault.lookup(rel.split('/'))
    const row = this.db.read((sqlite) => this.row(sqlite, rel))
    if (!stat?.isFile()) throw new HttpError(404, 'not_found', 'Couldn’t find that document.')
    if (row && Math.trunc(stat.mtimeMs) === row.mtime_ms && stat.size === row.size) return row
    await this.vault.runLocked(async () => {
      const result = await this.ingestExisting(rel, 'outside')
      if (result === 'upserted' || result === 'removed')
        await this.vault.publishChange({
          path: rel,
          kind: result === 'removed' ? 'deleted' : 'written',
          to: null,
          by: 'outside',
        })
    })
    const fresh = this.db.read((sqlite) => this.row(sqlite, rel))
    if (!fresh) throw new HttpError(404, 'not_found', 'Couldn’t find that document.')
    return fresh
  }

  /** A document to stream to the client: nothing of it is read into memory but the first bytes (for sniffing). */
  async open(input: string): Promise<{
    stream: ReadStream
    size: number
    head: Buffer
    type: KnowledgeDocumentType
    name: string
  }> {
    const rel = this.knownPath(input)
    const { abs, stat } = await this.vault.lookup(rel.split('/'))
    if (!stat?.isFile()) throw new HttpError(404, 'not_found', 'Couldn’t find that document.')
    const opened = await this.vault.openContainedStream(abs, MAX_STORE_BYTES)
    return { ...opened, type: documentTypeOfPath(rel)!, name: path.posix.basename(rel) }
  }

  /** For agents: the extracted text (bounded by the caller), or a notice when there is none. */
  async agentRead(input: string): Promise<{
    path: string
    title: string
    body: string
    etag: string
    notice: string | null
  }> {
    const document = await this.get(input)
    const row = this.db.read((sqlite) => this.row(sqlite, document.path))!
    let notice: string | null = null
    if (document.textStatus === 'unavailable')
      notice =
        'No text could be extracted from this file (it may be scanned, encrypted or damaged).'
    else if (document.textStatus === 'too_large')
      notice = 'This file is over 25 MB, so its text was not read.'
    else if (document.textStatus === 'none')
      notice = `This is ${document.type === 'image' ? 'an image' : 'a zip file'}; it has no text.`
    else if (document.textStatus === 'truncated')
      notice = 'The text was cut at 2 MiB when the file was added.'
    return {
      path: document.path,
      title: path.posix.basename(document.path),
      body: document.text,
      etag: row.hash.slice(0, 32),
      notice,
    }
  }

  /** FTS matches for documents, best first; `rank` lets the vault merge them with notes. */
  search(
    match: string,
    limit: number,
  ): Array<{
    path: string
    title: string
    snippet: string
    rank: number
    type: KnowledgeDocumentType
  }> {
    return this.db.read((sqlite) =>
      sqlite
        .prepare(
          `SELECT f.path AS path, f.title AS title, snippet(knowledge_doc_fts, -1, '[[', ']]', '…', 16) AS snippet,
                  bm25(knowledge_doc_fts, 0.0, 8.0, 1.0) AS rank, d.type AS type
           FROM knowledge_doc_fts f JOIN knowledge_documents d ON d.id = f.rowid
           WHERE knowledge_doc_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(match, limit)
        .map((row) =>
          z
            .object({
              path: z.string(),
              title: z.string(),
              snippet: z.string(),
              rank: z.number(),
              type: DocRowSchema.shape.type,
            })
            .parse(row),
        ),
    )
  }

  // ---- preparing (outside the lock) -------------------------------------------------------------------------

  private async documentFacts(
    rel: string,
    type: KnowledgeDocumentType,
    bytes: Buffer,
    /** The file's size when `bytes` holds only its start (a big file read for validation only). */
    size = bytes.length,
  ): Promise<PreparedDocument> {
    let text = ''
    let status: TextStatus = 'none'
    let entries: PreparedDocument['entries'] = null
    if (size > MAX_READ_BYTES) {
      // Stored, not read: no text work for a big file. A zip still lists what it holds.
      status = 'too_large'
      if (type === 'zip' && bytes.length === size) entries = await this.zipEntries(bytes)
      return { kind: 'document', path: rel, type, bytes, text, status, entries }
    }
    if (PLAIN_TEXT_TYPES.includes(type)) {
      const raw = bytes.toString('utf8')
      text = Buffer.byteLength(raw) > MAX_TEXT_BYTES ? '' : raw
      status = 'indexed'
      if (Buffer.byteLength(raw) > MAX_TEXT_BYTES) {
        text = new TextDecoder().decode(bytes.subarray(0, MAX_TEXT_BYTES)).replace(/�+$/, '')
        status = 'truncated'
      }
    } else if (WORKER_TEXT_TYPES.includes(type)) {
      const out = await extractDocumentText(type as 'pdf' | 'docx' | 'html', bytes)
      text = out.text
      status = out.status
    } else if (type === 'zip') {
      entries = await this.zipEntries(bytes)
    }
    // D6: nothing that looks like a credential is stored in the index, like notes written by agents.
    if (text !== '') text = redact(text)
    if (
      (status === 'indexed' || status === 'truncated') &&
      text.trim() === '' &&
      type !== 'csv' &&
      type !== 'json'
    )
      status = 'unavailable'
    return { kind: 'document', path: rel, type, bytes, text, status, entries }
  }

  /** Runs the zip lister on a private temporary copy of the archive on disk (removed afterwards). */
  private async listZip(bytes: Buffer): Promise<Awaited<ReturnType<typeof runWorker>>> {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'score-zip-'))
    try {
      const file = path.join(scratch, 'input.zip')
      await fs.writeFile(file, bytes, { mode: 0o600 })
      return await runWorker({ op: 'zip-list', file, limits: ZIP_LIMITS }, ZIP_TIMEOUT_MS)
    } finally {
      await fs.rm(scratch, { recursive: true, force: true })
    }
  }

  private async zipEntries(bytes: Buffer): Promise<PreparedDocument['entries']> {
    const listed = await this.listZip(bytes)
    return listed.ok && 'entries' in listed
      ? listed.entries.map(({ path: entry, size }) => ({ path: entry, size }))
      : null
  }

  /** Validates a file by name and bytes and extracts its text. Throws HttpError (415/413/400) when not acceptable. */
  async prepare(rel: string, bytes: Buffer): Promise<Prepared> {
    const segments = cleanSegments(rel)
    const dir = segments.slice(0, -1)
    const cls = classifyName(segments.at(-1)!)
    if (!cls)
      throw new HttpError(
        415,
        'unsupported_type',
        'This file type isn’t supported. Use notes, PDF, DOCX, CSV, JSON, HTML, images or zip files.',
      )
    if (bytes.length === 0) throw new HttpError(400, 'bad_request', 'That file is empty.')
    if (bytes.length > MAX_STORE_BYTES)
      throw new HttpError(413, 'payload_too_large', 'Files can be at most 256 MB.')
    const finalPath = [...dir, cls.name].join('/')
    if (cls.kind === 'note') {
      if (bytes.length > MAX_NOTE_BYTES)
        throw new HttpError(413, 'payload_too_large', 'Notes can be at most 8 MB.')
      if (!isPlainText(bytes))
        throw new HttpError(415, 'unsupported_type', 'That file isn’t plain text.')
      // The same checks as an ordinary save, so an upload or zip import can't make a note that can't be saved again.
      prepareNoteContent(bytes.toString('utf8'))
      return { kind: 'note', path: finalPath, bytes }
    }
    if (!bytesMatch(cls.type, bytes))
      throw new HttpError(
        415,
        'unsupported_type',
        `That file isn’t a real ${cls.type.toUpperCase()} file.`,
      )
    return this.documentFacts(finalPath, cls.type, bytes)
  }

  // ---- uploads ----------------------------------------------------------------------------------------------

  /** Is something at `rel`? */
  private async existing(
    rel: string,
  ): Promise<{ path: string; mtime: string; size: number } | null> {
    const { stat } = await this.vault.lookup(rel.split('/'))
    if (!stat) return null
    return { path: rel, mtime: new Date(stat.mtimeMs).toISOString(), size: stat.size }
  }

  /** The content hash of the file at `rel` right now (null when there is none or it can't be read). */
  private async versionOf(rel: string): Promise<string | null> {
    const { abs, stat } = await this.vault.lookup(rel.split('/'))
    if (!stat?.isFile()) return null
    return this.vault.hashContained(abs, MAX_STORE_BYTES).catch(() => null)
  }

  /** A free name next to `rel`: not on disk and not among `reserved` (lower-cased names other incoming files take). */
  private async freeName(rel: string, reserved: ReadonlySet<string> = new Set()): Promise<string> {
    for (let n = 2; n < 100; n += 1) {
      const candidate = suffixed(rel, n)
      if (!reserved.has(candidate.toLowerCase()) && !(await this.existing(candidate)))
        return candidate
    }
    throw new HttpError(409, 'exists', 'Too many files with that name.')
  }

  private exists(found: { path: string; mtime: string; size: number }[]): HttpError {
    return new HttpError(409, 'exists', 'A file with that name already exists.', {
      existing: found.slice(0, 50),
    })
  }

  /** One uploaded file (not a zip being unpacked). Notes go through the vault's note writer. */
  async upload(
    input: string,
    bytes: Buffer,
    onConflict: OnConflict,
    author: KnowledgeAuthor = 'you',
  ): Promise<KnowledgeUploadResult> {
    const prepared = await this.prepare(input, bytes)
    let target = prepared.path
    let replace = false
    // What the person chose to replace: publishing checks the file is still this version (null: nothing there).
    let expectHash: string | null = null
    const clash = await this.existing(target)
    if (clash) {
      if (onConflict === 'ask') throw this.exists([clash])
      if (onConflict === 'keep') target = await this.freeName(target)
      else {
        replace = true
        expectHash = await this.versionOf(target)
      }
    }
    try {
      return await this.publishUpload(prepared, target, replace, expectHash, author)
    } catch (error) {
      // Something took the name after the check: with ask or keep that is the same "already exists" the check gives.
      if (!replace && error instanceof HttpError && error.status === 412) throw this.exists([])
      throw error
    }
  }

  private async publishUpload(
    prepared: Prepared,
    target: string,
    replace: boolean,
    expectHash: string | null,
    author: KnowledgeAuthor,
  ): Promise<KnowledgeUploadResult> {
    if (prepared.kind === 'note') {
      const raw = prepared.bytes.toString('utf8')
      const current = replace ? await this.vault.readNote(target).catch(() => null) : null
      const written = await this.vault.writeNote(
        target,
        { body: raw, etag: current?.etag ?? null },
        author,
        true,
      )
      return { path: written.path, kind: 'note', replaced: replace, history: written.history }
    }
    return this.vault.runLocked(async () => {
      const again = await this.existing(target)
      if (again && !replace) throw this.exists([again])
      if (again) {
        const { stat } = await this.vault.lookup(target.split('/'))
        if (!stat?.isFile()) throw new HttpError(400, 'bad_path', 'A folder has that name.')
      }
      const placed = await this.place({ ...prepared, path: target }, author, { hash: expectHash })
      return {
        path: target,
        kind: 'document' as const,
        replaced: again !== null,
        history: placed.history,
      }
    })
  }

  /**
   * Whether history applies to a document: size only decides eligibility (a bigger file stays out unless it was
   * versioned before or git tracks it); then the same ignore rule as for notes. An ignored, untracked path is stored
   * but not versioned, and never force-added (decision 80).
   */
  private async keptInHistory(rel: string, size: number, known: boolean): Promise<boolean> {
    if (size > MAX_VERSIONED_BYTES && !known && this.trackedHint?.has(rel) !== true) return false
    return !(await this.vault.ignoredUntracked([rel])).has(rel)
  }

  /**
   * Writes one prepared document and indexes it (caller holds the lock). Says whether it is in git and what the
   * commit did; in a batch the commit is the caller's, so `history` is only a placeholder there.
   */
  private async place(
    document: PreparedDocument,
    author: KnowledgeAuthor,
    expect: { hash: string | null },
    batch?: string[],
  ): Promise<{ versioned: boolean; history: KnowledgeHistoryStatus }> {
    const existed = expect.hash !== null
    const rel = document.path
    const previous = this.db.read((sqlite) => this.row(sqlite, rel))
    // A batch snapshots outside changes once, before its first file; later files are Score's own.
    if (!batch) await this.vault.commitOutside()
    const abs = await this.vault.prepareParent(rel)
    await this.vault.atomicWrite(abs, document.bytes, expect)
    const stat = await fs.lstat(abs)
    const versioned = await this.keptInHistory(
      rel,
      document.bytes.length,
      previous?.versioned === 1,
    )
    this.db.tx((sqlite) =>
      this.writeIndex(
        sqlite,
        rel,
        { mtimeMs: stat.mtimeMs, size: stat.size, hash: hashContent(document.bytes), versioned },
        document,
        author,
      ),
    )
    let history: KnowledgeHistoryStatus = versioned ? 'committed' : 'not_versioned'
    if (batch) {
      if (versioned) batch.push(rel)
    } else {
      if (versioned)
        history = (
          await this.vault.commitPaths([rel], `${existed ? 'Replace' : 'Add'} ${rel}`, author)
        ).history
      await this.vault.publishChange({ path: rel, kind: 'written', to: null, by: author })
    }
    return { versioned, history }
  }

  // ---- delete and move -------------------------------------------------------------------------------------

  async delete(input: string, author: KnowledgeAuthor = 'you'): Promise<void> {
    const rel = this.knownPath(input)
    return this.vault.runLocked(async () => {
      const { abs, stat } = await this.vault.lookup(rel.split('/'))
      if (!stat?.isFile()) throw new HttpError(404, 'not_found', 'Couldn’t find that document.')
      const row = this.db.read((sqlite) => this.row(sqlite, rel))
      await this.vault.commitOutside()
      await fs.unlink(abs)
      if (row === undefined || row.versioned === 1)
        await this.vault.commitPaths([rel], `Delete ${rel}`, author)
      this.db.tx((sqlite) => this.removeIndex(sqlite, rel))
      await this.vault.publishChange({ path: rel, kind: 'deleted', to: null, by: author })
    })
  }

  async move(
    fromInput: string,
    toInput: string,
    author: KnowledgeAuthor = 'you',
  ): Promise<{
    path: string
    updatedNotes: number
    skipped: Array<{ path: string; reason: string }>
  }> {
    const from = this.knownPath(fromInput)
    const to = cleanSegments(toInput).join('/')
    if (documentTypeOfPath(to) !== documentTypeOfPath(from))
      throw new HttpError(400, 'bad_path', 'A document keeps its file type when it is renamed.')
    return this.vault.runLocked(async () => {
      const source = await this.vault.lookup(from.split('/'))
      if (!source.stat?.isFile())
        throw new HttpError(404, 'not_found', 'Couldn’t find that document.')
      if (from === to || (await this.existing(to)))
        throw new HttpError(409, 'exists', 'A file with that name already exists.')
      await this.vault.commitOutside()
      const row = this.db.read((sqlite) => this.row(sqlite, from))
      const abs = await this.vault.prepareParent(to)
      await this.vault.moveNoReplace(source.abs, abs)
      if (row === undefined || row.versioned === 1)
        await this.vault.commitPaths([from, to], `Move ${from} to ${to}`, author)
      this.db.tx((sqlite) => {
        if (!row) return
        const text = this.textOf(sqlite, row.id)
        sqlite.prepare('UPDATE knowledge_documents SET path = ? WHERE id = ?').run(to, row.id)
        if (row.text_status === 'indexed' || row.text_status === 'truncated') {
          sqlite.prepare('DELETE FROM knowledge_doc_fts WHERE rowid = ?').run(row.id)
          sqlite
            .prepare('INSERT INTO knowledge_doc_fts (rowid, path, title, body) VALUES (?, ?, ?, ?)')
            .run(row.id, to, path.posix.basename(to), text)
        }
      })
      await this.vault.publishChange({ path: from, kind: 'moved', to, by: author })
      return { path: to, updatedNotes: 0, skipped: [] }
    })
  }

  // ---- scanning --------------------------------------------------------------------------------------------

  /** Indexes the file at `rel` from disk (caller holds the lock). Null when it is not a valid document. */
  private async ingestExisting(
    rel: string,
    author: KnowledgeAuthor | null,
  ): Promise<IngestOutcome> {
    const type = documentTypeOfPath(rel)
    const { abs, stat } = await this.vault.lookup(rel.split('/'))
    if (!type || !stat?.isFile() || stat.size > MAX_STORE_BYTES) return this.dropIndex(rel)
    const big = stat.size > MAX_READ_BYTES
    // A big file is hashed in chunks and never read whole: it is only checked from its start (and a DOCX's zip
    // directory at its end), then stored as too_large.
    const hash = big ? await this.vault.hashContained(abs, MAX_STORE_BYTES) : null
    const known = this.db.read((sqlite) => this.row(sqlite, rel))
    if (hash !== null && known?.hash === hash) return this.markUnchanged(rel, stat)
    let bytes: Buffer
    let match: boolean
    if (big) {
      const checked = await bigFileMatches(type, stat.size, (position, length) =>
        this.vault.readContainedRange(abs, position, length),
      )
      bytes = checked.head
      match = checked.ok
    } else {
      bytes = await this.vault.readContainedBuffer(abs, MAX_READ_BYTES)
      match = bytesMatch(type, bytes)
    }
    const fileHash = hash ?? hashContent(bytes)
    if (hash === null && known?.hash === fileHash) return this.markUnchanged(rel, stat)
    // A file whose bytes don't match its extension is left alone (and unlisted), not indexed as something it isn't.
    const facts = match ? await this.documentFacts(rel, type, bytes, stat.size) : null
    if (!facts) return this.dropIndex(rel)
    // A rebuild has no rows to remember, so git's tracking stands in for them.
    const versioned = await this.keptInHistory(rel, stat.size, known?.versioned === 1)
    this.db.tx((sqlite) =>
      this.writeIndex(
        sqlite,
        rel,
        { mtimeMs: stat.mtimeMs, size: stat.size, hash: fileHash, versioned },
        facts,
        author,
      ),
    )
    return 'upserted'
  }

  private markUnchanged(rel: string, stat: { mtimeMs: number; size: number }): IngestOutcome {
    this.db.tx((sqlite) =>
      sqlite
        .prepare('UPDATE knowledge_documents SET mtime_ms = ?, size = ? WHERE path = ?')
        .run(Math.trunc(stat.mtimeMs), stat.size, rel),
    )
    return 'unchanged'
  }

  /** Drops the row for a file that is no longer an indexable document; says whether there was one. */
  private dropIndex(rel: string): IngestOutcome {
    const had = this.db.read((sqlite) => this.row(sqlite, rel)) !== undefined
    if (had) this.db.tx((sqlite) => this.removeIndex(sqlite, rel))
    return had ? 'removed' : 'unchanged'
  }

  /** Brings the document index in line with the files found by the vault's walk (caller holds the lock). */
  async scan(
    files: Map<string, { mtimeMs: number; size: number }>,
    announce: boolean,
    verify: (rel: string) => boolean = () => false,
    covered: (rel: string) => boolean = () => true,
  ): Promise<string[]> {
    const known = new Map(this.db.read((sqlite) => this.rows(sqlite)).map((row) => [row.path, row]))
    const changed: string[] = []
    const dropped = new Set<string>()
    for (const rel of known.keys())
      if (!files.has(rel) && covered(rel)) {
        this.db.tx((sqlite) => this.removeIndex(sqlite, rel))
        changed.push(rel)
      }
    for (const [rel, stat] of files) {
      const row = known.get(rel)
      if (
        row &&
        !verify(rel) &&
        Math.trunc(stat.mtimeMs) === row.mtime_ms &&
        stat.size === row.size
      )
        continue
      try {
        const outcome = await this.ingestExisting(rel, announce || row ? 'outside' : null)
        if (outcome === 'upserted') changed.push(rel)
        else if (outcome === 'removed') {
          changed.push(rel)
          dropped.add(rel)
        }
      } catch {
        // 'unreadable' (vanished, or not a plain file inside the vault): the index keeps what it has
      }
    }
    if (announce)
      for (const rel of changed.slice(0, MAX_EVENTS))
        await this.vault.publishChange({
          path: rel,
          kind: files.has(rel) && !dropped.has(rel) ? 'written' : 'deleted',
          to: null,
          by: 'outside',
        })
    return changed
  }

  fillAuthors(authors: Map<string, string>): void {
    this.db.tx((sqlite) => {
      const update = sqlite.prepare(
        'UPDATE knowledge_documents SET last_author = ? WHERE path = ? AND last_author IS NULL',
      )
      for (const [rel, column] of authors) update.run(column, rel)
    })
  }

  // ---- zip -------------------------------------------------------------------------------------------------

  async zipPreview(bytes: Buffer): Promise<KnowledgeZipPreview> {
    if (!bytesMatch('zip', bytes))
      throw new HttpError(415, 'unsupported_type', 'That isn’t a zip file.')
    const listed = await this.listZip(bytes)
    if (!listed.ok) throw zipFailure(listed)
    if (!('entries' in listed))
      throw new HttpError(415, 'unsupported_type', 'Couldn’t read that zip file.')
    return {
      entries: listed.entries,
      more: listed.more,
      extractCount: listed.entries.filter((entry) => entry.action === 'extract').length,
    }
  }

  /** Unpacks a zip into `folder` as one commit. Every file goes through the same checks as a single upload. */
  async unzip(
    zipBytes: Buffer,
    zipName: string,
    folderInput: string,
    onConflict: OnConflict,
    author: KnowledgeAuthor = 'you',
  ): Promise<KnowledgeUnzipResult> {
    if (!bytesMatch('zip', zipBytes))
      throw new HttpError(415, 'unsupported_type', 'That isn’t a zip file.')
    const folder = cleanSegments(folderInput).join('/')
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'score-unzip-'))
    try {
      const zipFile = path.join(scratch, 'input.zip')
      await fs.writeFile(zipFile, zipBytes, { mode: 0o600 })
      const out = await runWorker(
        { op: 'zip-extract', file: zipFile, outDir: path.join(scratch, 'out'), limits: ZIP_LIMITS },
        ZIP_TIMEOUT_MS,
      )
      if (!out.ok) throw zipFailure(out)
      if (!('files' in out))
        throw new HttpError(415, 'unsupported_type', 'Couldn’t read that zip file.')
      const skipped = [...out.skipped]
      // Only one extracted file is in memory at a time: each is checked here, then dropped, and read again from the
      // scratch folder when it is placed (an unzip can total 1 GB).
      const prepared: Unpacked[] = []
      const taken = new Set<string>()
      for (const file of out.files) {
        try {
          const item = await this.prepare(`${folder}/${file.path}`, await fs.readFile(file.file))
          if (taken.has(item.path.toLowerCase())) {
            skipped.push({ path: file.path, reason: 'name clashes with another file in the zip' })
            continue
          }
          taken.add(item.path.toLowerCase())
          prepared.push({
            path: item.path,
            file: file.file,
            facts: item.kind === 'document' ? withoutBytes(item) : null,
          })
        } catch (error) {
          skipped.push({
            path: file.path,
            reason: error instanceof HttpError ? error.message : 'could not be read',
          })
        }
      }
      const written = await this.vault.runLocked(async () => {
        const clashes: Array<{ path: string; mtime: string; size: number }> = []
        for (const item of prepared) {
          const clash = await this.existing(item.path)
          if (clash) clashes.push(clash)
        }
        if (clashes.length > 0 && onConflict === 'ask') throw this.exists(clashes)
        // What replace was chosen over: each file is published only while it still has this version.
        const replacing = new Map<string, string | null>()
        if (onConflict === 'replace')
          for (const clash of clashes) replacing.set(clash.path, await this.versionOf(clash.path))
        if (clashes.length > 0 && onConflict === 'keep') {
          // Renamed files must also avoid every other incoming name and each other.
          const reserved = new Set(prepared.map((item) => item.path.toLowerCase()))
          for (const item of prepared) {
            const clash = clashes.find((candidate) => candidate.path === item.path)
            if (!clash) continue
            item.path = await this.freeName(item.path, reserved)
            reserved.add(item.path.toLowerCase())
          }
        }
        await this.vault.commitOutside()
        const committed: string[] = []
        const done: Unpacked[] = []
        for (const item of prepared) {
          const { stat } = await this.vault.lookup(item.path.split('/'))
          if (stat && !stat.isFile()) {
            skipped.push({ path: item.path, reason: 'a folder has that name' })
            continue
          }
          const expect = { hash: replacing.get(item.path) ?? null }
          try {
            if (item.facts) {
              const bytes = await fs.readFile(item.file)
              await this.place({ ...item.facts, path: item.path, bytes }, author, expect, committed)
            } else {
              const abs = await this.vault.prepareParent(item.path)
              await this.vault.atomicWrite(abs, await fs.readFile(item.file, 'utf8'), expect)
              await this.vault.indexNote(item.path, author)
              committed.push(item.path)
            }
          } catch (error) {
            // Something else took or changed the name after the check: it stays as it is, the rest carries on.
            if (error instanceof HttpError && (error.status === 409 || error.status === 412)) {
              skipped.push({
                path: item.path,
                reason: 'it changed while the files were being added',
              })
              continue
            }
            throw error
          }
          done.push(item)
        }
        let history: KnowledgeHistoryStatus = 'not_versioned'
        if (committed.length > 0)
          history = (await this.vault.commitPaths(committed, `Unzipped ${zipName}`, author)).history
        for (const item of done.slice(0, MAX_EVENTS))
          await this.vault.publishChange({ path: item.path, kind: 'written', to: null, by: author })
        return { paths: done.map((item) => item.path), history }
      })
      return { folder, written: written.paths, skipped, history: written.history }
    } finally {
      await fs.rm(scratch, { recursive: true, force: true })
    }
  }
}
