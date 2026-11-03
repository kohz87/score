import type { DatabaseSync } from 'node:sqlite'
import { SharedWorkspaceSchema, type SharedWorkspace } from '@score/contract'
import { z } from 'zod'

// Shared workspaces (3.20.0): named folders agents are assigned to, many to many. Plain data here; the folder rules
// (`checkRoot`) are applied by the routes when a folder is added and by the coding runtime every time one is used.

const RowSchema = z.object({ id: z.string(), name: z.string(), path: z.string() })

function assemble(sqlite: DatabaseSync, row: z.infer<typeof RowSchema>): SharedWorkspace {
  const agentIds = sqlite
    .prepare('SELECT agent_id FROM workspace_agents WHERE workspace_id = ? ORDER BY agent_id')
    .all(row.id)
    .map((r) => z.object({ agent_id: z.string() }).parse(r).agent_id)
  const roomIds = sqlite
    .prepare('SELECT id FROM rooms WHERE workspace_id = ? ORDER BY name, id')
    .all(row.id)
    .map((r) => z.object({ id: z.string() }).parse(r).id)
  return SharedWorkspaceSchema.parse({ ...row, agentIds, roomIds })
}

export function listSharedWorkspaces(sqlite: DatabaseSync): SharedWorkspace[] {
  return sqlite
    .prepare('SELECT id, name, path FROM workspaces ORDER BY name, id')
    .all()
    .map((row) => assemble(sqlite, RowSchema.parse(row)))
}

export function getSharedWorkspace(sqlite: DatabaseSync, id: string): SharedWorkspace | null {
  const row = sqlite.prepare('SELECT id, name, path FROM workspaces WHERE id = ?').get(id)
  return row === undefined ? null : assemble(sqlite, RowSchema.parse(row))
}

/**
 * The folder a room has chosen for `agentId`: the room's workspace path when the room has one AND the agent is assigned
 * to it, else null (the caller then uses the agent's own folder). The path is stored as it was when added; the caller
 * must run it through `checkRoot` before using it.
 */
export function roomWorkspacePathFor(
  sqlite: DatabaseSync,
  roomId: string,
  agentId: string,
): string | null {
  const row = sqlite
    .prepare(
      `SELECT w.path FROM rooms r
         JOIN workspaces w ON w.id = r.workspace_id
         JOIN workspace_agents a ON a.workspace_id = w.id AND a.agent_id = ?
       WHERE r.id = ?`,
    )
    .get(agentId, roomId)
  return row === undefined ? null : z.object({ path: z.string() }).parse(row).path
}
