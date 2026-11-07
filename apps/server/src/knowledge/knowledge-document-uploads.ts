import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  KnowledgeAuthor,
  KnowledgeDocumentType,
  KnowledgeHistoryStatus,
  KnowledgeUploadResult,
} from '@score/contract'
import { HttpError } from '../errors.ts'
import { isPlainText } from '../media/sniff.ts'
import { redact } from '../redact.ts'
import {
  bytesMatch,
  classifyName,
  MAX_READ_BYTES,
  MAX_STORE_BYTES,
  MAX_TEXT_BYTES,
  MAX_VERSIONED_BYTES,
  PLAIN_TEXT_TYPES,
  WORKER_TEXT_TYPES,
} from './doc-types.ts'
import { extractDocumentText, runWorker, ZIP_LIMITS, ZIP_TIMEOUT_MS } from './extract.ts'
import { KnowledgeDocumentIndex } from './knowledge-document-index.ts'
import {
  cleanSegments,
  suffixed,
  type OnConflict,
  type Prepared,
  type PreparedDocument,
  type TextStatus,
} from './knowledge-document-model.ts'
import { hashContent, MAX_NOTE_BYTES } from './note.ts'
import { prepareNoteContent } from './note-images.ts'

/** Prepares, validates and writes uploaded documents (PLAN 6.6); shared by uploads, moves and zip imports. */
export abstract class KnowledgeDocumentUploads extends KnowledgeDocumentIndex {
  // ---- preparing (outside the lock) -------------------------------------------------------------------------

  protected async documentFacts(
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
  protected async listZip(bytes: Buffer): Promise<Awaited<ReturnType<typeof runWorker>>> {
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
  protected async existing(
    rel: string,
  ): Promise<{ path: string; mtime: string; size: number } | null> {
    const { stat } = await this.vault.lookup(rel.split('/'))
    if (!stat) return null
    return { path: rel, mtime: new Date(stat.mtimeMs).toISOString(), size: stat.size }
  }

  /** The content hash of the file at `rel` right now (null when there is none or it can't be read). */
  protected async versionOf(rel: string): Promise<string | null> {
    const { abs, stat } = await this.vault.lookup(rel.split('/'))
    if (!stat?.isFile()) return null
    return this.vault.hashContained(abs, MAX_STORE_BYTES).catch(() => null)
  }

  /** A free name next to `rel`: not on disk and not among `reserved` (lower-cased names other incoming files take). */
  protected async freeName(
    rel: string,
    reserved: ReadonlySet<string> = new Set(),
  ): Promise<string> {
    for (let n = 2; n < 100; n += 1) {
      const candidate = suffixed(rel, n)
      if (!reserved.has(candidate.toLowerCase()) && !(await this.existing(candidate)))
        return candidate
    }
    throw new HttpError(409, 'exists', 'Too many files with that name.')
  }

  protected exists(found: { path: string; mtime: string; size: number }[]): HttpError {
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
  protected async keptInHistory(rel: string, size: number, known: boolean): Promise<boolean> {
    if (size > MAX_VERSIONED_BYTES && !known && this.trackedHint?.has(rel) !== true) return false
    return !(await this.vault.ignoredUntracked([rel])).has(rel)
  }

  /**
   * Writes one prepared document and indexes it (caller holds the lock). Says whether it is in git and what the
   * commit did; in a batch the commit is the caller's, so `history` is only a placeholder there.
   */
  protected async place(
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
}
