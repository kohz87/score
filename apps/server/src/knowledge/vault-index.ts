import { z } from 'zod'
import type { DatabaseSync } from 'node:sqlite'
import type { KnowledgeAuthor } from '@score/contract'
import { buildNoteIndex, parseWikilinks, resolveLink } from './links.ts'
import { authorToColumn, hashContent, MAX_NOTE_BYTES, noteTitle, parseNote } from './note.ts'
import { forIndex } from './note-images.ts'
import { isDocumentPath } from './doc-types.ts'
import { buildMonthIndex, memoryMonthDir } from './memory-notes.ts'
import {
  isNotFound,
  LinkRowSchema,
  MAX_DEPTH,
  MAX_EVENTS_PER_SCAN,
  MAX_FILES,
  NoteRowSchema,
  type NoteRow,
} from './vault-types.ts'
import type { VaultRuntime } from './vault-runtime.ts'

import fs from 'node:fs/promises'
import path from 'node:path'
import { HttpError } from '../errors.ts'

export const indexMethods = {
  // ---- index -------------------------------------------------------------------------------------------------

  noteRows(this: VaultRuntime, sqlite: DatabaseSync): NoteRow[] {
    return sqlite
      .prepare('SELECT * FROM knowledge_notes ORDER BY path')
      .all()
      .map((row) => NoteRowSchema.parse(row))
  },

  noteRow(this: VaultRuntime, sqlite: DatabaseSync, rel: string): NoteRow | undefined {
    const row = sqlite.prepare('SELECT * FROM knowledge_notes WHERE path = ?').get(rel)
    return row === undefined ? undefined : NoteRowSchema.parse(row)
  },

  upsert(
    this: VaultRuntime,
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
  },

  remove(this: VaultRuntime, sqlite: DatabaseSync, rel: string): void {
    const existing = this.noteRow(sqlite, rel)
    if (!existing) return
    sqlite.prepare('DELETE FROM knowledge_fts WHERE rowid = ?').run(existing.id)
    sqlite.prepare('DELETE FROM knowledge_notes WHERE id = ?').run(existing.id)
    sqlite.prepare('DELETE FROM knowledge_links WHERE from_path = ?').run(rel)
  },

  /** Re-resolves every link: a new, removed or moved note changes what other notes' links point at. */
  relink(this: VaultRuntime, sqlite: DatabaseSync): void {
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
  },

  /** Indexes one file after a Score write (caller holds the lock). */
  async indexFile(
    this: VaultRuntime,
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
  },

  async walk(this: VaultRuntime): Promise<{
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
  },

  /**
   * Brings the index in line with the files: new and changed by `(mtime, size)` then hash, removed dropped.
   * With `announce`, each change is published as made by "outside" (an edit Score did not make).
   */
  async scan(this: VaultRuntime, announce: boolean, verifyAll = false): Promise<string[]> {
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
  },

  /** Rebuilds the monthly memory indexes of the memory notes that changed (inside the vault lock). */
  async refreshMemoryIndexes(
    this: VaultRuntime,
    changed: string[],
    author: KnowledgeAuthor = 'outside',
  ): Promise<void> {
    const dirs = new Set(changed.flatMap((rel) => memoryMonthDir(rel) ?? []))
    for (const dir of dirs)
      await this.writeMemoryIndex(dir, author).catch((error: unknown) =>
        this.options.log?.warn({ err: error }, 'Couldn’t rebuild a memory index'),
      )
  },

  /** Writes `<dir>/index.md` from the indexed notes of that month; leaves it alone when it is already right. */
  async writeMemoryIndex(this: VaultRuntime, dir: string, author: KnowledgeAuthor): Promise<void> {
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
  },

  /** Fills "who last changed it" for notes the index has no author for yet, from git history. */
  async fillAuthors(this: VaultRuntime): Promise<void> {
    const authors = await this.git.lastAuthors()
    if (authors.size === 0) return
    this.options.db.tx((sqlite) => {
      const update = sqlite.prepare(
        'UPDATE knowledge_notes SET last_author = ? WHERE path = ? AND last_author IS NULL',
      )
      for (const [rel, column] of authors) update.run(column, rel)
    })
    this.docs.fillAuthors(authors)
  },

  /** Drops the index and rebuilds it from the files (it is disposable). */
  rebuild(this: VaultRuntime): Promise<void> {
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
  },

  /** Runs one scan now (the watcher and the timer do this too). */
  scanNow(this: VaultRuntime, announce = true): Promise<string[]> {
    // An explicit scan checks content, not just (mtime, size).
    return this.serial(() => this.scan(announce, true))
  },
}

export type IndexMethods = typeof indexMethods
