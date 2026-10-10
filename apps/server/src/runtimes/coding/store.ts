import {
  CodingPermissionSchema,
  CodingRuntimeSchema,
  ShapeSchema,
  type CodingPermission,
  type CodingRuntime,
} from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

const RowSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  runtime: CodingRuntimeSchema,
  workspace: z.string(),
  permission: CodingPermissionSchema,
  model: z.string().nullable(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  shape: ShapeSchema,
  confirmed_version: z.string().nullable(),
  created_at: z.iso.datetime(),
  removed_at: z.string().nullable(),
})
export interface StoredCodingAgent {
  id: string
  name: string
  role: string
  runtime: CodingRuntime
  workspace: string
  permission: CodingPermission
  model: string | null
  style: { color: string; shape: z.infer<typeof ShapeSchema> }
  confirmedVersion: string | null
  createdAt: string
  removedAt: string | null
}
const toAgent = (value: unknown): StoredCodingAgent => {
  const row = RowSchema.parse(value)
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    runtime: row.runtime,
    workspace: row.workspace,
    permission: row.permission,
    model: row.model,
    style: { color: row.color, shape: row.shape },
    confirmedVersion: row.confirmed_version,
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
  agent: Omit<StoredCodingAgent, 'confirmedVersion' | 'removedAt'>,
): void {
  sqlite
    .prepare(
      `INSERT INTO coding_agents (id, name, role, runtime, workspace, permission, model, color, shape, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      agent.id,
      agent.name,
      agent.role,
      agent.runtime,
      agent.workspace,
      agent.permission,
      agent.model,
      agent.style.color,
      agent.style.shape,
      agent.createdAt,
    )
}
export function updateCodingAgent(
  sqlite: DatabaseSync,
  id: string,
  patch: Partial<
    Pick<
      StoredCodingAgent,
      'name' | 'role' | 'permission' | 'model' | 'workspace' | 'confirmedVersion'
    >
  >,
): void {
  const columns: Record<string, string> = {
    name: 'name',
    role: 'role',
    permission: 'permission',
    model: 'model',
    workspace: 'workspace',
    confirmedVersion: 'confirmed_version',
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    sqlite.prepare(`UPDATE coding_agents SET ${columns[key]!} = ? WHERE id = ?`).run(value, id)
  }
}
export function removeCodingAgent(sqlite: DatabaseSync, id: string, now: string): void {
  sqlite.prepare('UPDATE coding_agents SET removed_at = ? WHERE id = ?').run(now, id)
  // Same transaction: a deleted agent's MCP token and switches must not outlive it.
  sqlite.prepare('DELETE FROM mcp_access WHERE agent_id = ?').run(id)
}

export function cliSessionFor(
  sqlite: DatabaseSync,
  roomId: string,
  agentId: string,
): string | null {
  const row = sqlite
    .prepare('SELECT session_id FROM coding_sessions WHERE room_id = ? AND agent_id = ?')
    .get(roomId, agentId) as { session_id: string } | undefined
  return row?.session_id ?? null
}
export function rememberCliSession(
  sqlite: DatabaseSync,
  roomId: string,
  agentId: string,
  sessionId: string,
  now: string,
): void {
  sqlite
    .prepare(
      `INSERT INTO coding_sessions (room_id, agent_id, session_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (room_id, agent_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
    )
    .run(roomId, agentId, sessionId, now)
}
export function forgetCliSession(sqlite: DatabaseSync, roomId: string, agentId: string): void {
  sqlite
    .prepare('DELETE FROM coding_sessions WHERE room_id = ? AND agent_id = ?')
    .run(roomId, agentId)
}
