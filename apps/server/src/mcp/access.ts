import { MCP_POSTS_PER_HOUR, MCP_TOKEN_PATTERN } from '@score/contract'
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { DatabaseSync } from 'node:sqlite'
import type { ScoreDb } from '../db/index.ts'
import { lifecycleOf } from '../domain/agent-lifecycle.ts'
import { HttpError } from '../errors.ts'

const HOUR = 60 * 60 * 1000

const RowSchema = z.object({
  agent_id: z.string(),
  enabled: z.number(),
  writes_enabled: z.number(),
  incarnation_id: z.string().nullable(),
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
    // A removed, half-deleted or replaced agent has no access, whatever the row says.
    if (!this.current(parsed.agent_id, parsed.incarnation_id))
      return { enabled: false, writesEnabled: false, hasToken: false, tokenCreatedAt: null }
    return {
      enabled: parsed.enabled === 1,
      writesEnabled: parsed.writes_enabled === 1,
      hasToken: parsed.token_hash !== null,
      tokenCreatedAt: parsed.token_created_at,
    }
  }

  /** True while the agent exists in the incarnation the row was made for and is ready. */
  private current(agentId: string, stored: string | null): boolean {
    const life = this.db.read((sqlite) => lifecycleOf(sqlite, agentId))
    if (!life) {
      // Coding agents have no lifecycle row: a removed one has no access.
      const removed = this.db.read((sqlite) =>
        sqlite
          .prepare('SELECT 1 FROM coding_agents WHERE id = ? AND removed_at IS NOT NULL')
          .get(agentId),
      )
      if (removed !== undefined) return false
      return stored === null
    }
    if (life.state !== 'ready') return false
    return stored === null || stored === life.incarnation_id
  }

  /** Makes the agent's row (dropping one left by another incarnation) and returns nothing; call inside a transaction. */
  private ensure(sqlite: DatabaseSync, agentId: string): void {
    const existing = sqlite
      .prepare('SELECT incarnation_id FROM mcp_access WHERE agent_id = ?')
      .get(agentId) as { incarnation_id: string | null } | undefined
    const incarnation = lifecycleOf(sqlite, agentId)?.incarnation_id ?? null
    if (existing?.incarnation_id != null && existing.incarnation_id !== incarnation)
      sqlite.prepare('DELETE FROM mcp_access WHERE agent_id = ?').run(agentId)
    else if (existing && existing.incarnation_id === null && incarnation !== null)
      // A profile Score began tracking after the switches were set: they belong to it.
      sqlite
        .prepare('UPDATE mcp_access SET incarnation_id = ? WHERE agent_id = ?')
        .run(incarnation, agentId)
    sqlite
      .prepare('INSERT OR IGNORE INTO mcp_access (agent_id, incarnation_id) VALUES (?, ?)')
      .run(agentId, incarnation)
  }

  patch(agentId: string, change: { enabled?: boolean; writesEnabled?: boolean }): void {
    this.db.tx((sqlite) => {
      this.ensure(sqlite, agentId)
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
      this.ensure(sqlite, agentId)
      sqlite
        .prepare(
          'UPDATE mcp_access SET token_hash = ?, token_created_at = ?, listed_tools = NULL, listed_at = NULL WHERE agent_id = ?',
        )
        .run(hashMcpToken(token), this.clock(), agentId)
    })
    return token
  }

  revokeToken(agentId: string): void {
    this.db.tx((sqlite) =>
      sqlite
        .prepare(
          'UPDATE mcp_access SET token_hash = NULL, token_created_at = NULL, listed_tools = NULL, listed_at = NULL WHERE agent_id = ?',
        )
        .run(agentId),
    )
  }

  /**
   * 3.7.8: what Score just handed this agent's Hermes on `tools/list` (it keeps that list until it reloads MCP). Only
   * while `token` is still the agent's key: a list handed under a key rotated meanwhile doesn't count.
   */
  recordListed(agentId: string, names: readonly string[], token?: string): void {
    this.db.tx((sqlite) =>
      token === undefined
        ? sqlite
            .prepare('UPDATE mcp_access SET listed_tools = ?, listed_at = ? WHERE agent_id = ?')
            .run(JSON.stringify([...names].sort()), this.clock(), agentId)
        : sqlite
            .prepare(
              'UPDATE mcp_access SET listed_tools = ?, listed_at = ? WHERE agent_id = ? AND token_hash = ?',
            )
            .run(JSON.stringify([...names].sort()), this.clock(), agentId, hashMcpToken(token)),
    )
  }

  /** The tools this agent's Hermes was last handed, or null when it hasn't asked since its token was issued. */
  listed(agentId: string): { names: string[]; at: number } | null {
    const row = this.db.read((sqlite) =>
      sqlite
        .prepare('SELECT listed_tools, listed_at FROM mcp_access WHERE agent_id = ?')
        .get(agentId),
    ) as { listed_tools: string | null; listed_at: number | null } | undefined
    if (!row?.listed_tools || row.listed_at === null) return null
    const names = z.array(z.string()).safeParse(JSON.parse(row.listed_tools))
    return names.success ? { names: names.data, at: row.listed_at } : null
  }

  /** The agent a bearer token belongs to, or undefined for a malformed, unknown or revoked token. */
  agentForToken(token: string): { agentId: string } | undefined {
    if (!MCP_TOKEN_PATTERN.test(token)) return undefined
    const row = this.db.read((sqlite) =>
      sqlite.prepare('SELECT * FROM mcp_access WHERE token_hash = ?').get(hashMcpToken(token)),
    )
    if (row === undefined) return undefined
    const parsed = RowSchema.parse(row)
    return this.current(parsed.agent_id, parsed.incarnation_id)
      ? { agentId: parsed.agent_id }
      : undefined
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
