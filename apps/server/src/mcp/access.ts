import { MCP_POSTS_PER_HOUR, MCP_TOKEN_PATTERN } from '@score/contract'
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'

const HOUR = 60 * 60 * 1000

const RowSchema = z.object({
  agent_id: z.string(),
  enabled: z.number(),
  writes_enabled: z.number(),
  token_hash: z.string().nullable(),
  token_created_at: z.number().nullable(),
})

export interface McpAgentState {
  enabled: boolean
  writesEnabled: boolean
  hasToken: boolean
  tokenCreatedAt: number | null
}

export const hashMcpToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

// Per-agent switches, tokens and the post budget behind the MCP server (contract §13). Identity is the token's row:
// nothing a client sends can name another agent.
export class McpAccessStore {
  constructor(
    private readonly db: ScoreDb,
    private readonly clock: () => number = Date.now,
  ) {}

  get(agentId: string): McpAgentState {
    const row = this.db.read((sqlite) =>
      sqlite.prepare('SELECT * FROM mcp_access WHERE agent_id = ?').get(agentId),
    )
    if (row === undefined)
      return { enabled: false, writesEnabled: false, hasToken: false, tokenCreatedAt: null }
    const parsed = RowSchema.parse(row)
    return {
      enabled: parsed.enabled === 1,
      writesEnabled: parsed.writes_enabled === 1,
      hasToken: parsed.token_hash !== null,
      tokenCreatedAt: parsed.token_created_at,
    }
  }

  patch(agentId: string, change: { enabled?: boolean; writesEnabled?: boolean }): void {
    this.db.tx((sqlite) => {
      sqlite.prepare('INSERT OR IGNORE INTO mcp_access (agent_id) VALUES (?)').run(agentId)
      if (change.enabled !== undefined)
        sqlite
          .prepare('UPDATE mcp_access SET enabled = ? WHERE agent_id = ?')
          .run(change.enabled ? 1 : 0, agentId)
      if (change.writesEnabled !== undefined)
        sqlite
          .prepare('UPDATE mcp_access SET writes_enabled = ? WHERE agent_id = ?')
          .run(change.writesEnabled ? 1 : 0, agentId)
    })
  }

  /** Creates or rotates: the previous token stops working at once. The plaintext is returned here and nowhere else. */
  issueToken(agentId: string): string {
    const token = `scm_${randomBytes(32).toString('base64url')}`
    this.db.tx((sqlite) => {
      sqlite.prepare('INSERT OR IGNORE INTO mcp_access (agent_id) VALUES (?)').run(agentId)
      sqlite
        .prepare('UPDATE mcp_access SET token_hash = ?, token_created_at = ? WHERE agent_id = ?')
        .run(hashMcpToken(token), this.clock(), agentId)
    })
    return token
  }

  revokeToken(agentId: string): void {
    this.db.tx((sqlite) =>
      sqlite
        .prepare(
          'UPDATE mcp_access SET token_hash = NULL, token_created_at = NULL WHERE agent_id = ?',
        )
        .run(agentId),
    )
  }

  /** The agent a bearer token belongs to, or undefined for a malformed, unknown or revoked token. */
  agentForToken(token: string): { agentId: string } | undefined {
    if (!MCP_TOKEN_PATTERN.test(token)) return undefined
    const row = this.db.read((sqlite) =>
      sqlite
        .prepare('SELECT agent_id FROM mcp_access WHERE token_hash = ?')
        .get(hashMcpToken(token)),
    )
    return row === undefined
      ? undefined
      : { agentId: z.object({ agent_id: z.string() }).parse(row).agent_id }
  }

  postsLastHour(agentId: string): number {
    return z
      .object({ count: z.number() })
      .parse(
        this.db.read((sqlite) =>
          sqlite
            .prepare('SELECT COUNT(*) AS count FROM mcp_posts WHERE agent_id = ? AND at > ?')
            .get(agentId, this.clock() - HOUR),
        ),
      ).count
  }

  /** Reserves a post slot before the post (concurrent calls cannot overshoot); returns the undo for a failed post. */
  reservePost(agentId: string, tool: string): () => void {
    const now = this.clock()
    const used = this.db.tx((sqlite) => {
      const recent = z
        .object({ count: z.number(), oldest: z.number().nullable() })
        .parse(
          sqlite
            .prepare(
              'SELECT COUNT(*) AS count, MIN(at) AS oldest FROM mcp_posts WHERE agent_id = ? AND at > ?',
            )
            .get(agentId, now - HOUR),
        )
      if (recent.count >= MCP_POSTS_PER_HOUR)
        return {
          retryAfterSeconds: Math.max(1, Math.ceil(((recent.oldest ?? now) + HOUR - now) / 1000)),
        }
      const id = sqlite
        .prepare('INSERT INTO mcp_posts (agent_id, tool, at) VALUES (?, ?, ?)')
        .run(agentId, tool, now).lastInsertRowid
      return { id: Number(id) }
    })
    if ('retryAfterSeconds' in used)
      throw new HttpError(
        429,
        'rate_limited',
        `Too many posts: the limit is ${MCP_POSTS_PER_HOUR} per hour. Try again in ${used.retryAfterSeconds} seconds.`,
        { retryAfterSeconds: used.retryAfterSeconds },
      )
    return () =>
      this.db.tx((sqlite) => sqlite.prepare('DELETE FROM mcp_posts WHERE id = ?').run(used.id))
  }
}
