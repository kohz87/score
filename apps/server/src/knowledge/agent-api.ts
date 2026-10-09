import type {
  KnowledgeSearchHit,
} from '@score/contract'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'
import { redact } from '../redact.ts'
import type { KnowledgeVault } from './vault.ts'

export const AGENT_WRITE_BYTES = 256 * 1024
export const AGENT_READ_BYTES = 256 * 1024
export const AGENT_LIST_ITEMS = 200
export const AGENT_WRITES_PER_HOUR = 60
const HOUR = 60 * 60 * 1000

export interface AgentListing {
  folders: string[]
  notes: { path: string; title: string; mtime: string }[]
  truncated: boolean
}

// What the bridge's knowledge tools call (contract §11). The agent id always comes from the authenticated producer.
// Every operation checks both switches first, so turning knowledge off takes effect on the next tool call.
export class KnowledgeAgentApi {
  constructor(
    private readonly vault: KnowledgeVault,
    private readonly db: ScoreDb,
    private readonly clock: () => number = Date.now,
  ) {}

  agentEnabled(agentId: string): boolean {
    const row = this.db.read((sqlite) =>
      sqlite.prepare('SELECT enabled FROM knowledge_agent_access WHERE agent_id = ?').get(agentId),
    )
    return row === undefined ? true : z.object({ enabled: z.number() }).parse(row).enabled === 1
  }

  setAgentEnabled(agentId: string, enabled: boolean): void {
    this.db.tx((sqlite) =>
      sqlite
        .prepare(
          `INSERT INTO knowledge_agent_access (agent_id, enabled) VALUES (?, ?)
           ON CONFLICT (agent_id) DO UPDATE SET enabled = excluded.enabled`,
        )
        .run(agentId, enabled ? 1 : 0),
    )
  }

  /** Writes since local midnight, per agent. */
  usageToday(): { agentId: string; writesToday: number }[] {
    const midnight = new Date(this.clock())
    midnight.setHours(0, 0, 0, 0)
    const rows = this.db.read((sqlite) =>
      sqlite
        .prepare(
          `SELECT agent_id, COUNT(*) AS count FROM knowledge_agent_writes WHERE at >= ?
           GROUP BY agent_id ORDER BY agent_id`,
        )
        .all(midnight.getTime()),
    )
    return z
      .array(z.object({ agent_id: z.string(), count: z.number() }))
      .parse(rows)
      .map((row) => ({ agentId: row.agent_id, writesToday: row.count }))
  }

  private gate(agentId: string): void {
    if (!this.vault.agentAccess() || !this.agentEnabled(agentId))
      throw new HttpError(403, 'knowledge_off', 'Knowledge is turned off for agents')
  }

  /** Reserves a write slot before the write (so concurrent calls can't overshoot) and returns its undo. */
  private reserve(agentId: string): () => void {
    const now = this.clock()
    const used = this.db.tx((sqlite) => {
      const count = z
        .object({ count: z.number() })
        .parse(
          sqlite
            .prepare('SELECT COUNT(*) AS count FROM knowledge_agent_writes WHERE agent_id = ? AND at > ?')
            .get(agentId, now - HOUR),
        ).count
      if (count >= AGENT_WRITES_PER_HOUR) {
        const oldest = z
          .object({ at: z.number() })
          .parse(
            sqlite
              .prepare('SELECT MIN(at) AS at FROM knowledge_agent_writes WHERE agent_id = ? AND at > ?')
              .get(agentId, now - HOUR),
          ).at
        return { retryAfterSeconds: Math.max(1, Math.ceil((oldest + HOUR - now) / 1000)) }
      }
      const id = sqlite
        .prepare('INSERT INTO knowledge_agent_writes (agent_id, at) VALUES (?, ?)')
        .run(agentId, now).lastInsertRowid
      return { id: Number(id) }
    })
    if ('retryAfterSeconds' in used)
      throw new HttpError(
        429,
        'rate_limited',
        `Too many knowledge writes: the limit is ${AGENT_WRITES_PER_HOUR} per hour. Try again in ${used.retryAfterSeconds} seconds.`,
        { retryAfterSeconds: used.retryAfterSeconds },
      )
    return () =>
      this.db.tx((sqlite) =>
        sqlite.prepare('DELETE FROM knowledge_agent_writes WHERE id = ?').run(used.id),
      )
  }

  private checkSize(text: string): void {
    if (Buffer.byteLength(text) > AGENT_WRITE_BYTES)
      throw new HttpError(
        413,
        'payload_too_large',
        `That is too large: an agent write may be at most ${AGENT_WRITE_BYTES / 1024} KiB.`,
      )
  }

  search(agentId: string, query: string, limit: number): { items: KnowledgeSearchHit[] } {
    this.gate(agentId)
    return { items: this.vault.search(query, Math.min(limit, 20)).slice(0, AGENT_LIST_ITEMS) }
  }

  async read(agentId: string, path: string) {
    this.gate(agentId)
    const note = await this.vault.readNote(path)
    let body = note.body
    let truncated = false
    if (Buffer.byteLength(body) > AGENT_READ_BYTES) {
      // Cut on a character boundary: decoding a byte slice drops the partial trailing sequence.
      body = new TextDecoder('utf-8').decode(Buffer.from(body).subarray(0, AGENT_READ_BYTES))
      body = body.replace(/�+$/, '')
      truncated = true
    }
    return { path: note.path, title: note.title, body, etag: note.etag, truncated }
  }

  async list(agentId: string, folder: string | undefined): Promise<AgentListing> {
    this.gate(agentId)
    const prefix = (folder ?? '').replace(/^\/+|\/+$/g, '')
    if (prefix.split('/').some((part) => part === '..' || part === '.git'))
      throw new HttpError(400, 'bad_path', 'That folder is not in the vault')
    const tree = await this.vault.tree()
    const inside = (path: string) => prefix === '' || path === prefix || path.startsWith(`${prefix}/`)
    const folders = tree.folders.filter((path) => inside(path) && path !== prefix)
    const notes = tree.notes.filter((note) => inside(note.path))
    const total = folders.length + notes.length
    const keptFolders = folders.slice(0, AGENT_LIST_ITEMS)
    return {
      folders: keptFolders,
      notes: notes
        .slice(0, AGENT_LIST_ITEMS - keptFolders.length)
        .map(({ path, title, mtime }) => ({ path, title, mtime })),
      truncated: total > AGENT_LIST_ITEMS,
    }
  }

  async write(agentId: string, path: string, body: string, expectedEtag: string | null) {
    this.gate(agentId)
    this.checkSize(body)
    const release = this.reserve(agentId)
    try {
      return await this.vault.writeNote(
        path,
        { body: redact(body), etag: expectedEtag },
        { agentId },
      )
    } catch (error) {
      release()
      throw await this.conflict(error, path)
    }
  }

  async append(agentId: string, path: string, text: string) {
    this.gate(agentId)
    this.checkSize(text)
    const release = this.reserve(agentId)
    const addition = redact(text)
    try {
      // The vault serialises writes but not our read-then-write pair: retry when someone saved in between.
      for (let attempt = 0; ; attempt++) {
        const current = await this.vault.readNote(path).catch((error: unknown) => {
          if (error instanceof HttpError && error.status === 404) return null
          throw error
        })
        const body = current
          ? `${current.body}${current.body === '' || current.body.endsWith('\n') ? '' : '\n'}${addition}`
          : addition
        try {
          return await this.vault.writeNote(
            path,
            { body, etag: current?.etag ?? null },
            { agentId },
          )
        } catch (error) {
          const raced =
            error instanceof HttpError && (error.status === 412 || error.code === 'exists')
          if (!raced || attempt >= 4) throw error
        }
      }
    } catch (error) {
      release()
      throw await this.conflict(error, path)
    }
  }

  // The vault answers 412/`exists`; the tools contract is a 409 that carries the current etag.
  private async conflict(error: unknown, path: string): Promise<unknown> {
    if (!(error instanceof HttpError)) return error
    if (error.status === 412)
      return new HttpError(
        409,
        'conflict',
        'The note changed since you read it. Read it again, then retry with the new etag.',
        error.details,
      )
    if (error.code === 'exists') {
      const current = await this.vault.readNote(path).catch(() => null)
      return new HttpError(
        409,
        'exists',
        'A note with that name already exists. Read it, then write with its etag (or use knowledge_append).',
        { etag: current?.etag ?? null },
      )
    }
    return error
  }
}
