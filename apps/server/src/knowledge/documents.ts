import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type {
  KnowledgeAuthor,
  KnowledgeDocument,
  KnowledgeDocumentSummary,
  KnowledgeDocumentType,
  KnowledgeTextStatusSchema,
  KnowledgeUnzipResult,
  KnowledgeUploadResult,
  KnowledgeZipPreview,
} from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'
import { isPlainText } from '../media/sniff.ts'
import { redact } from '../redact.ts'
import {
  bytesMatch,
  classifyName,
  documentTypeOfPath,
  MAX_FILE_BYTES,
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
  text_status: z.enum(['indexed', 'truncated', 'unavailable', 'none']),
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
    throw new HttpError(400, 'bad_path', 'Hidden files and folders are not part of the vault')
  return segments
}

/**
 * Uploaded documents in the vault (PLAN 6.6): PDF, DOCX, CSV, JSON, HTML, images and zips next to the Markdown notes.
 * The files are the truth; the DB rows and the FTS text are an index. All changes run through the vault's lock.
 */
export class KnowledgeDocuments {
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
      throw new HttpError(400, 'not_a_document', 'That is not a document')
    return rel
  }

  /** The document's row, after indexing a change that happened behind the scanner's back. */
  private async reconcile(rel: string): Promise<DocRow> {
    const { stat } = await this.vault.lookup(rel.split('/'))
    const row = this.db.read((sqlite) => this.row(sqlite, rel))
    if (!stat?.isFile()) throw new HttpError(404, 'not_found', 'Unknown document')
    if (row && Math.trunc(stat.mtimeMs) === row.mtime_ms && stat.size === row.size) return row
    await this.vault.runLocked(async () => {
      const result = await this.ingestExisting(rel, 'outside')
      if (result)
        await this.vault.publishChange({ path: rel, kind: 'written', to: null, by: 'outside' })
    })
    const fresh = this.db.read((sqlite) => this.row(sqlite, rel))
    if (!fresh) throw new HttpError(404, 'not_found', 'Unknown document')
    return fresh
  }

  async bytes(
    input: string,
  ): Promise<{ bytes: Buffer; type: KnowledgeDocumentType; name: string }> {
    const rel = this.knownPath(input)
    const { abs, stat } = await this.vault.lookup(rel.split('/'))
    if (!stat?.isFile()) throw new HttpError(404, 'not_found', 'Unknown document')
    if (stat.size > MAX_FILE_BYTES)
      throw new HttpError(413, 'payload_too_large', 'That file is too large')
    return {
      bytes: await this.vault.readContainedBuffer(abs),
      type: documentTypeOfPath(rel)!,
      name: path.posix.basename(rel),
    }
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
  ): Promise<PreparedDocument> {
    let text = ''
    let status: TextStatus = 'none'
    let entries: PreparedDocument['entries'] = null
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
      const listed = await runWorker({ op: 'zip-list', bytes, limits: ZIP_LIMITS }, ZIP_TIMEOUT_MS)
      if (listed.ok && 'entries' in listed)
        entries = listed.entries.map(({ path: entry, size }) => ({ path: entry, size }))
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

  /** Validates a file by name and bytes and extracts its text. Throws HttpError (415/413/400) when not acceptable. */
  async prepare(rel: string, bytes: Buffer): Promise<Prepared> {
    const segments = cleanSegments(rel)
    const dir = segments.slice(0, -1)
    const cls = classifyName(segments.at(-1)!)
    if (!cls)
      throw new HttpError(
        415,
        'unsupported_type',
        'That file type is not supported (notes, PDF, DOCX, CSV, JSON, HTML, images and zip files are)',
      )
    if (bytes.length === 0) throw new HttpError(400, 'bad_request', 'That file is empty')
    if (bytes.length > MAX_FILE_BYTES)
      throw new HttpError(413, 'payload_too_large', 'Files can be at most 25 MB')
    const finalPath = [...dir, cls.name].join('/')
    if (cls.kind === 'note') {
      if (bytes.length > MAX_NOTE_BYTES)
        throw new HttpError(413, 'payload_too_large', 'Notes can be at most 2 MiB')
      if (!isPlainText(bytes))
        throw new HttpError(415, 'unsupported_type', 'That file is not plain text')
      return { kind: 'note', path: finalPath, bytes }
    }
    if (!bytesMatch(cls.type, bytes))
      throw new HttpError(
        415,
        'unsupported_type',
        `That file is not a real ${cls.type.toUpperCase()} file`,
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

  private async freeName(rel: string): Promise<string> {
    for (let n = 2; n < 100; n += 1) {
      const candidate = suffixed(rel, n)
      if (!(await this.existing(candidate))) return candidate
    }
    throw new HttpError(409, 'exists', 'Too many files with that name')
  }

  private exists(found: { path: string; mtime: string; size: number }[]): HttpError {
    return new HttpError(409, 'exists', 'A file with that name already exists', {
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
    const clash = await this.existing(target)
    if (clash) {
      if (onConflict === 'ask') throw this.exists([clash])
      if (onConflict === 'keep') target = await this.freeName(target)
      else replace = true
    }
    if (prepared.kind === 'note') {
      const raw = prepared.bytes.toString('utf8')
      const current = replace ? await this.vault.readNote(target).catch(() => null) : null
      const written = await this.vault.writeNote(
        target,
        { body: raw, etag: current?.etag ?? null },
        author,
        true,
      )
      return { path: written.path, kind: 'note', replaced: replace }
    }
    return this.vault.runLocked(async () => {
      const again = await this.existing(target)
      if (again && !replace) throw this.exists([again])
      if (again) {
        const { stat } = await this.vault.lookup(target.split('/'))
        if (!stat?.isFile()) throw new HttpError(400, 'bad_path', 'A folder has that name')
      }
      await this.place({ ...prepared, path: target }, author, again !== null)
      return { path: target, kind: 'document' as const, replaced: again !== null }
    })
  }

  /** Writes one prepared document and indexes it (caller holds the lock). Returns whether it is in git. */
  private async place(
    document: PreparedDocument,
    author: KnowledgeAuthor,
    existed: boolean,
    batch?: string[],
  ): Promise<boolean> {
    const rel = document.path
    const previous = this.db.read((sqlite) => this.row(sqlite, rel))
    // A batch snapshots outside changes once, before its first file; later files are Score's own.
    if (!batch) await this.vault.commitOutside()
    const abs = await this.vault.prepareParent(rel)
    await this.vault.atomicWrite(abs, document.bytes)
    const stat = await fs.lstat(abs)
    const versioned = document.bytes.length <= MAX_VERSIONED_BYTES || previous?.versioned === 1
    this.db.tx((sqlite) =>
      this.writeIndex(
        sqlite,
        rel,
        { mtimeMs: stat.mtimeMs, size: stat.size, hash: hashContent(document.bytes), versioned },
        document,
        author,
      ),
    )
    if (batch) {
      if (versioned) batch.push(rel)
    } else {
      if (versioned)
        await this.vault.commitPaths([rel], `${existed ? 'Replace' : 'Add'} ${rel}`, author)
      await this.vault.publishChange({ path: rel, kind: 'written', to: null, by: author })
    }
    return versioned
  }

  // ---- delete and move -------------------------------------------------------------------------------------

  async delete(input: string, author: KnowledgeAuthor = 'you'): Promise<void> {
    const rel = this.knownPath(input)
    return this.vault.runLocked(async () => {
      const { abs, stat } = await this.vault.lookup(rel.split('/'))
      if (!stat?.isFile()) throw new HttpError(404, 'not_found', 'Unknown document')
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
  ): Promise<{ path: string; updatedNotes: number }> {
    const from = this.knownPath(fromInput)
    const to = cleanSegments(toInput).join('/')
    if (documentTypeOfPath(to) !== documentTypeOfPath(from))
      throw new HttpError(400, 'bad_path', 'A document keeps its file type when it is renamed')
    return this.vault.runLocked(async () => {
      const source = await this.vault.lookup(from.split('/'))
      if (!source.stat?.isFile()) throw new HttpError(404, 'not_found', 'Unknown document')
      if (from === to || (await this.existing(to)))
        throw new HttpError(409, 'exists', 'A file with that name already exists')
      await this.vault.commitOutside()
      const row = this.db.read((sqlite) => this.row(sqlite, from))
      const abs = await this.vault.prepareParent(to)
      await fs.rename(source.abs, abs)
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
      return { path: to, updatedNotes: 0 }
    })
  }

  // ---- scanning --------------------------------------------------------------------------------------------

  /** Indexes the file at `rel` from disk (caller holds the lock). Null when it is not a valid document. */
  private async ingestExisting(rel: string, author: KnowledgeAuthor | null): Promise<boolean> {
    const type = documentTypeOfPath(rel)
    const { abs, stat } = await this.vault.lookup(rel.split('/'))
    if (!type || !stat?.isFile() || stat.size > MAX_FILE_BYTES) {
      this.db.tx((sqlite) => this.removeIndex(sqlite, rel))
      return false
    }
    const bytes = await this.vault.readContainedBuffer(abs)
    const hash = hashContent(bytes)
    const known = this.db.read((sqlite) => this.row(sqlite, rel))
    if (known?.hash === hash) {
      this.db.tx((sqlite) =>
        sqlite
          .prepare('UPDATE knowledge_documents SET mtime_ms = ?, size = ? WHERE path = ?')
          .run(Math.trunc(stat.mtimeMs), stat.size, rel),
      )
      return false
    }
    // A file whose bytes don't match its extension is left alone (and unlisted), not indexed as something it isn't.
    const facts = bytesMatch(type, bytes) ? await this.documentFacts(rel, type, bytes) : null
    if (!facts) {
      this.db.tx((sqlite) => this.removeIndex(sqlite, rel))
      return false
    }
    this.db.tx((sqlite) =>
      this.writeIndex(
        sqlite,
        rel,
        {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          hash,
          versioned: stat.size <= MAX_VERSIONED_BYTES || known?.versioned === 1,
        },
        facts,
        author,
      ),
    )
    return true
  }

  /** Brings the document index in line with the files found by the vault's walk (caller holds the lock). */
  async scan(
    files: Map<string, { mtimeMs: number; size: number }>,
    announce: boolean,
  ): Promise<string[]> {
    const known = new Map(this.db.read((sqlite) => this.rows(sqlite)).map((row) => [row.path, row]))
    const changed: string[] = []
    for (const rel of known.keys())
      if (!files.has(rel)) {
        this.db.tx((sqlite) => this.removeIndex(sqlite, rel))
        changed.push(rel)
      }
    for (const [rel, stat] of files) {
      const row = known.get(rel)
      if (row && Math.trunc(stat.mtimeMs) === row.mtime_ms && stat.size === row.size) continue
      try {
        if (await this.ingestExisting(rel, announce || row ? 'outside' : null)) changed.push(rel)
      } catch {
        // vanished, or no longer a plain file inside the vault
      }
    }
    if (announce)
      for (const rel of changed.slice(0, MAX_EVENTS))
        await this.vault.publishChange({
          path: rel,
          kind: files.has(rel) ? 'written' : 'deleted',
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
      throw new HttpError(415, 'unsupported_type', 'That is not a zip file')
    const listed = await runWorker({ op: 'zip-list', bytes, limits: ZIP_LIMITS }, ZIP_TIMEOUT_MS)
    if (!listed.ok) throw zipFailure(listed)
    if (!('entries' in listed))
      throw new HttpError(415, 'unsupported_type', 'That zip file could not be read')
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
      throw new HttpError(415, 'unsupported_type', 'That is not a zip file')
    const folder = cleanSegments(folderInput).join('/')
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'score-unzip-'))
    try {
      const out = await runWorker(
        { op: 'zip-extract', bytes: zipBytes, outDir: scratch, limits: ZIP_LIMITS },
        ZIP_TIMEOUT_MS,
      )
      if (!out.ok) throw zipFailure(out)
      if (!('files' in out))
        throw new HttpError(415, 'unsupported_type', 'That zip file could not be read')
      const skipped = [...out.skipped]
      const prepared: Prepared[] = []
      const taken = new Set<string>()
      for (const file of out.files) {
        const bytes = await fs.readFile(file.file)
        try {
          const item = await this.prepare(`${folder}/${file.path}`, bytes)
          if (taken.has(item.path.toLowerCase())) {
            skipped.push({ path: file.path, reason: 'name clashes with another file in the zip' })
            continue
          }
          taken.add(item.path.toLowerCase())
          prepared.push(item)
        } catch (error) {
          skipped.push({
            path: file.path,
            reason: error instanceof HttpError ? error.message : 'could not be read',
          })
        }
        await fs.rm(file.file, { force: true })
      }
      const written = await this.vault.runLocked(async () => {
        const clashes: Array<{ path: string; mtime: string; size: number }> = []
        for (const item of prepared) {
          const clash = await this.existing(item.path)
          if (clash) clashes.push(clash)
        }
        if (clashes.length > 0 && onConflict === 'ask') throw this.exists(clashes)
        if (clashes.length > 0 && onConflict === 'keep')
          for (const item of prepared) {
            const clash = clashes.find((candidate) => candidate.path === item.path)
            if (clash) item.path = await this.freeName(item.path)
          }
        await this.vault.commitOutside()
        const committed: string[] = []
        const done: Prepared[] = []
        for (const item of prepared) {
          const { stat } = await this.vault.lookup(item.path.split('/'))
          if (stat && !stat.isFile()) {
            skipped.push({ path: item.path, reason: 'a folder has that name' })
            continue
          }
          if (item.kind === 'document') {
            await this.place(item, author, stat !== null, committed)
          } else {
            const abs = await this.vault.prepareParent(item.path)
            await this.vault.atomicWrite(abs, item.bytes.toString('utf8'))
            await this.vault.indexNote(item.path, author)
            committed.push(item.path)
          }
          done.push(item)
        }
        if (committed.length > 0)
          await this.vault.commitPaths(committed, `Unzipped ${zipName}`, author)
        for (const item of done.slice(0, MAX_EVENTS))
          await this.vault.publishChange({ path: item.path, kind: 'written', to: null, by: author })
        return done.map((item) => item.path)
      })
      return { folder, written, skipped }
    } finally {
      await fs.rm(scratch, { recursive: true, force: true })
    }
  }
}
