import {
  AgentLookSchema,
  DEFAULT_QUOTA_FLOOR_PERCENT,
  CodingPermissionSchema,
  CodingQuotaSchema,
  CodingRuntimeSchema,
  ShapeSchema,
  type AgentStyle,
  type CodingPermission,
  type CodingQuota,
  type CodingRuntime,
} from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { parsePack } from '../../packs/meta.ts'

const RowSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  instructions: z.string(),
  runtime: CodingRuntimeSchema,
  workspace: z.string(),
  permission: CodingPermissionSchema,
  model: z.string().nullable(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  shape: ShapeSchema,
  look: AgentLookSchema,
  pack_rev: z.string().nullable(),
  pack_meta: z.string().nullable(),
  confirmed_version: z.string().nullable(),
  quota_floor_percent: z.int().min(0).max(50),
  created_at: z.iso.datetime(),
  removed_at: z.string().nullable(),
})
export interface StoredCodingAgent {
  id: string
  name: string
  role: string
  /** The owner's "Personality and instructions" (PLAN 8.8). */
  instructions: string
  runtime: CodingRuntime
  workspace: string
  permission: CodingPermission
  model: string | null
  style: AgentStyle
  confirmedVersion: string | null
  quotaFloorPercent: number
  createdAt: string
  removedAt: string | null
}
const toAgent = (value: unknown): StoredCodingAgent => {
  const row = RowSchema.parse(value)
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    instructions: row.instructions,
    runtime: row.runtime,
    workspace: row.workspace,
    permission: row.permission,
    model: row.model,
    style: {
      color: row.color,
      shape: row.shape,
      look: row.look,
      pack: parsePack(row.pack_rev, row.pack_meta),
    },
    confirmedVersion: row.confirmed_version,
    quotaFloorPercent: row.quota_floor_percent,
    createdAt: row.created_at,
    removedAt: row.removed_at,
  }
}

export function listCodingAgents(sqlite: DatabaseSync, withRemoved = false): StoredCodingAgent[] {
  return sqlite
    .prepare(
      `SELECT * FROM coding_agents ${withRemoved ? '' : 'WHERE removed_at IS NULL'} ORDER BY created_at, id`,
    )
    .all()
    .map(toAgent)
}
export function getCodingAgent(
  sqlite: DatabaseSync,
  id: string,
  withRemoved = false,
): StoredCodingAgent | null {
  const row = sqlite.prepare('SELECT * FROM coding_agents WHERE id = ?').get(id)
  const agent = row === undefined ? null : toAgent(row)
  return agent && (withRemoved || agent.removedAt === null) ? agent : null
}
export function isCodingAgent(sqlite: DatabaseSync, id: string): boolean {
  return (
    sqlite.prepare('SELECT 1 FROM coding_agents WHERE id = ? AND removed_at IS NULL').get(id) !==
    undefined
  )
}
export function insertCodingAgent(
  sqlite: DatabaseSync,
  agent: Omit<
    StoredCodingAgent,
    'confirmedVersion' | 'removedAt' | 'quotaFloorPercent' | 'instructions'
  > & {
    quotaFloorPercent?: number
    instructions?: string
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO coding_agents (id, name, role, instructions, runtime, workspace, permission, model, color, shape, look, created_at, quota_floor_percent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      agent.id,
      agent.name,
      agent.role,
      agent.instructions ?? '',
      agent.runtime,
      agent.workspace,
      agent.permission,
      agent.model,
      agent.style.color,
      agent.style.shape,
      agent.style.look ?? 'cut',
      agent.createdAt,
      agent.quotaFloorPercent ?? DEFAULT_QUOTA_FLOOR_PERCENT,
    )
}
export function updateCodingAgent(
  sqlite: DatabaseSync,
  id: string,
  patch: Partial<
    Pick<
      StoredCodingAgent,
      | 'name'
      | 'role'
      | 'instructions'
      | 'permission'
      | 'model'
      | 'workspace'
      | 'confirmedVersion'
      | 'quotaFloorPercent'
    >
  >,
): void {
  const columns: Record<string, string> = {
    name: 'name',
    role: 'role',
    instructions: 'instructions',
    permission: 'permission',
    model: 'model',
    workspace: 'workspace',
    confirmedVersion: 'confirmed_version',
    quotaFloorPercent: 'quota_floor_percent',
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    sqlite.prepare(`UPDATE coding_agents SET ${columns[key]!} = ? WHERE id = ?`).run(value, id)
  }
}
export function removeCodingAgent(sqlite: DatabaseSync, id: string, now: string): void {
  // The pack goes with the agent (its folder is removed by the caller).
  sqlite
    .prepare(
      'UPDATE coding_agents SET removed_at = ?, pack_rev = NULL, pack_meta = NULL WHERE id = ?',
    )
    .run(now, id)
  // Same transaction: a deleted agent's MCP token and switches must not outlive it.
  sqlite.prepare('DELETE FROM mcp_access WHERE agent_id = ?').run(id)
}

// A coding CLI's own session per (job, agent) (PLAN 11.1b; per room before): a job's turns resume it.
export function cliSessionFor(sqlite: DatabaseSync, jobId: string, agentId: string): string | null {
  const row = sqlite
    .prepare('SELECT session_id FROM coding_sessions WHERE job_id = ? AND agent_id = ?')
    .get(jobId, agentId) as { session_id: string } | undefined
  return row?.session_id ?? null
}
export function rememberCliSession(
  sqlite: DatabaseSync,
  jobId: string,
  agentId: string,
  sessionId: string,
  now: string,
): void {
  sqlite
    .prepare(
      `INSERT INTO coding_sessions (job_id, agent_id, session_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (job_id, agent_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
    )
    .run(jobId, agentId, sessionId, now)
}
/** The hash of the role/instructions block this session last received ('' = none; also for sessions from before 8.8). */
export function cliSessionInstructions(
  sqlite: DatabaseSync,
  jobId: string,
  agentId: string,
): string {
  const row = sqlite
    .prepare('SELECT instructions_hash FROM coding_sessions WHERE job_id = ? AND agent_id = ?')
    .get(jobId, agentId) as { instructions_hash: string | null } | undefined
  return row?.instructions_hash ?? ''
}
export function rememberCliInstructions(
  sqlite: DatabaseSync,
  jobId: string,
  agentId: string,
  hash: string,
): void {
  sqlite
    .prepare('UPDATE coding_sessions SET instructions_hash = ? WHERE job_id = ? AND agent_id = ?')
    .run(hash === '' ? null : hash, jobId, agentId)
}
export function forgetCliSession(sqlite: DatabaseSync, jobId: string, agentId: string): void {
  sqlite
    .prepare('DELETE FROM coding_sessions WHERE job_id = ? AND agent_id = ?')
    .run(jobId, agentId)
}

const QuotaRowSchema = z.object({
  agent_id: z.string(),
  runtime: CodingRuntimeSchema,
  seen_at: z.iso.datetime(),
  source: z.enum(['usage', 'turn', 'log']),
  windows: z.string(),
})
const toQuota = (value: unknown): CodingQuota | null => {
  const row = QuotaRowSchema.safeParse(value)
  if (!row.success) return null
  let windows: unknown
  try {
    windows = JSON.parse(row.data.windows)
  } catch {
    return null
  }
  const parsed = CodingQuotaSchema.safeParse({
    runtime: row.data.runtime,
    seenAt: row.data.seen_at,
    source: row.data.source,
    windows,
  })
  return parsed.success ? parsed.data : null
}

/** The latest quota reading of this agent (replaces the previous one). Only these validated numbers are stored. */
export function saveCodingQuota(sqlite: DatabaseSync, agentId: string, quota: CodingQuota): void {
  const valid = CodingQuotaSchema.parse(quota)
  sqlite
    .prepare(
      `INSERT INTO coding_quota (agent_id, runtime, seen_at, source, windows) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET runtime = excluded.runtime, seen_at = excluded.seen_at,
         source = excluded.source, windows = excluded.windows`,
    )
    .run(agentId, valid.runtime, valid.seenAt, valid.source, JSON.stringify(valid.windows))
}
export function getCodingQuota(sqlite: DatabaseSync, agentId: string): CodingQuota | null {
  const row = sqlite.prepare('SELECT * FROM coding_quota WHERE agent_id = ?').get(agentId)
  return row === undefined ? null : toQuota(row)
}
/** The most recent reading of any live agent of this runtime. */
export function latestCodingQuota(
  sqlite: DatabaseSync,
  runtime: CodingRuntime,
): CodingQuota | null {
  const row = sqlite
    .prepare(
      `SELECT q.* FROM coding_quota q JOIN coding_agents a ON a.id = q.agent_id
        WHERE q.runtime = ? AND a.removed_at IS NULL ORDER BY q.seen_at DESC LIMIT 1`,
    )
    .get(runtime)
  return row === undefined ? null : toQuota(row)
}
