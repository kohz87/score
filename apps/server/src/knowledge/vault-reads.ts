import { z } from 'zod'
import type {
  KnowledgeCommit,
  KnowledgeInfo,
  KnowledgeNote,
  KnowledgeSearchHit,
  KnowledgeTree,
} from '@score/contract'
import { authorFromColumn, etagOf, hashContent, parseNote, parseNotePath } from './note.ts'
import { HttpError } from '../errors.ts'
import type { VaultRuntime } from './vault-runtime.ts'

export const readMethods = {
  // ---- reads -------------------------------------------------------------------------------------------------

  agentAccess(this: VaultRuntime): boolean {
    const row = this.options.db.read((sqlite) =>
      sqlite.prepare('SELECT agent_access FROM knowledge_settings WHERE id = 1').get(),
    )
    return z.object({ agent_access: z.number() }).parse(row).agent_access === 1
  },

  /** Settings › Knowledge: "Save compacted summaries as memory notes". */
  memoryNotes(this: VaultRuntime): boolean {
    const row = this.options.db.read((sqlite) =>
      sqlite.prepare('SELECT memory_notes FROM knowledge_settings WHERE id = 1').get(),
    )
    return z.object({ memory_notes: z.number() }).parse(row).memory_notes === 1
  },

  setMemoryNotes(this: VaultRuntime, value: boolean): KnowledgeInfo {
    this.options.db.tx((sqlite) =>
      sqlite
        .prepare('UPDATE knowledge_settings SET memory_notes = ? WHERE id = 1')
        .run(value ? 1 : 0),
    )
    return this.info()
  },

  setAgentAccess(this: VaultRuntime, value: boolean): KnowledgeInfo {
    this.options.db.tx((sqlite) =>
      sqlite
        .prepare('UPDATE knowledge_settings SET agent_access = ? WHERE id = 1')
        .run(value ? 1 : 0),
    )
    return this.info()
  },

  info(this: VaultRuntime): KnowledgeInfo {
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
  },

  async tree(this: VaultRuntime): Promise<KnowledgeTree> {
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
  },

  async readNote(this: VaultRuntime, input: string): Promise<KnowledgeNote> {
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
  },

  search(this: VaultRuntime, query: string, limit: number): KnowledgeSearchHit[] {
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
  },

  async history(this: VaultRuntime, input: string): Promise<KnowledgeCommit[]> {
    const rel = parseNotePath(input)
    const items = await this.serial(() => this.git.history(rel))
    return items.map((item) => ({
      commit: item.commit,
      at: item.at,
      author: item.author,
      message: item.message,
    }))
  },

  async version(
    this: VaultRuntime,
    input: string,
    commit: string,
  ): Promise<{ commit: string; body: string }> {
    const rel = parseNotePath(input)
    const raw = await this.serial(() => this.git.version(rel, commit))
    if (raw === null) throw new HttpError(404, 'not_found', 'Couldn’t find that version.')
    return { commit, body: parseNote(raw).body }
  },
}

export type ReadMethods = typeof readMethods
