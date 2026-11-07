import type { ReadStream } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type {
  KnowledgeAuthor,
  KnowledgeDocument,
  KnowledgeDocumentSummary,
  KnowledgeDocumentType,
} from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'
import { documentTypeOfPath, MAX_STORE_BYTES, MAX_VERSIONED_BYTES } from './doc-types.ts'
import {
  DocRowSchema,
  EntriesSchema,
  cleanSegments,
  toSummary,
  type DocRow,
  type IngestOutcome,
  type PreparedDocument,
} from './knowledge-document-model.ts'
import { authorToColumn } from './note.ts'
import type { KnowledgeVault } from './vault.ts'

/** Uploaded documents in the vault (PLAN 6.6): rows, reads, search and index maintenance. */
export abstract class KnowledgeDocumentIndex {
  /** Paths git tracks, set only while the vault rebuilds the index; null otherwise. */
  trackedHint: Set<string> | null = null

  constructor(
    protected readonly vault: KnowledgeVault,
    protected readonly db: ScoreDb,
  ) {}

  // ---- rows ------------------------------------------------------------------------------------------------

  protected rows(sqlite: DatabaseSync): DocRow[] {
    return sqlite
      .prepare('SELECT * FROM knowledge_documents ORDER BY path')
      .all()
      .map((row) => DocRowSchema.parse(row))
  }
  protected row(sqlite: DatabaseSync, rel: string): DocRow | undefined {
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

  protected writeIndex(
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

  protected removeIndex(sqlite: DatabaseSync, rel: string): void {
    const existing = this.row(sqlite, rel)
    if (!existing) return
    sqlite.prepare('DELETE FROM knowledge_doc_fts WHERE rowid = ?').run(existing.id)
    sqlite.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(existing.id)
  }

  protected textOf(sqlite: DatabaseSync, id: number): string {
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

  protected knownPath(input: string): string {
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

  fillAuthors(authors: Map<string, string>): void {
    this.db.tx((sqlite) => {
      const update = sqlite.prepare(
        'UPDATE knowledge_documents SET last_author = ? WHERE path = ? AND last_author IS NULL',
      )
      for (const [rel, column] of authors) update.run(column, rel)
    })
  }

  protected abstract ingestExisting(
    rel: string,
    author: KnowledgeAuthor | null,
  ): Promise<IngestOutcome>
}
