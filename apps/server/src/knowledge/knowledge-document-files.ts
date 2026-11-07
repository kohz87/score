import fs from 'node:fs/promises'
import path from 'node:path'
import type { KnowledgeAuthor } from '@score/contract'
import { HttpError } from '../errors.ts'
import { bigFileMatches } from './big-file.ts'
import { bytesMatch, documentTypeOfPath, MAX_READ_BYTES, MAX_STORE_BYTES } from './doc-types.ts'
import { KnowledgeDocumentUploads } from './knowledge-document-uploads.ts'
import { MAX_EVENTS, cleanSegments, type IngestOutcome } from './knowledge-document-model.ts'
import { hashContent } from './note.ts'

/** Deleting, moving and scanning documents in the vault. */
export class KnowledgeDocumentFiles extends KnowledgeDocumentUploads {
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
  protected override async ingestExisting(
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
}
