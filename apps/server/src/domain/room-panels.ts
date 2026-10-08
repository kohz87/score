import type { DatabaseSync } from 'node:sqlite'
import { relative, isAbsolute } from 'node:path'
import { z } from 'zod'

// Read models for the Chat side panels, computed on request from rows the ingest path already stored.
const FILE_LIMIT = 12
const LEARNED_LIMIT = 5
const PATH_KEYS = ['path', 'file_path', 'filepath', 'file', 'filename', 'target_file']
const FILE_TOOL =
  /(^|[_.\-:])(file|files|edit|editor|patch|write|read|create|append|str_replace)([_.\-:]|$)/i

const ToolRowSchema = z.object({ tool: z.string(), preview: z.string().nullable(), at: z.string() })
const LearnedRowSchema = z.object({ data: z.string(), ts: z.string() })
const LearnedDataSchema = z.object({ agentIds: z.array(z.string()), text: z.string() })

// Previews are redacted JSON args (bridge) or a bare string (run SSE); accept either shape.
export function pathFromPreview(preview: string | null, root: string): string | null {
  if (preview === null) return null
  let candidate: string | null = null
  try {
    const value: unknown = JSON.parse(preview)
    if (typeof value === 'string') candidate = value
    else if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>
      for (const key of PATH_KEYS) {
        const found = record[key]
        if (typeof found === 'string' && found.length > 0) {
          candidate = found
          break
        }
      }
    }
  } catch {
    candidate = preview
  }
  candidate = candidate?.trim() ?? null
  // A bare preview is only a path when it looks like one (no spaces, no shell syntax).
  if (!candidate || candidate.length > 512 || /[\s|&;<>`$*?]/.test(candidate)) return null
  if (candidate.includes('\0') || !/[./\\]/.test(candidate)) return null
  if (isAbsolute(candidate) && root) {
    const rel = relative(root, candidate)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) candidate = rel
  }
  return candidate.replace(/^\.\//, '')
}

export function roomFilesInPlay(
  sqlite: DatabaseSync,
  roomId: string,
  root = process.cwd(),
): string[] {
  const rows = z.array(ToolRowSchema).parse(
    sqlite
      .prepare(
        `SELECT t.tool AS tool, t.preview AS preview, t.started_at AS at
           FROM message_runs m JOIN runs r ON r.id = m.run_id JOIN tool_calls t ON t.run_id = r.id
          WHERE m.room_id = ?
         UNION ALL
         SELECT s.tool, s.args_preview, s.started_at
           FROM message_runs m JOIN runs r ON r.id = m.run_id
           JOIN session_tool_calls s ON s.profile = r.profile AND s.session_id = r.session_id
          WHERE m.room_id = ?
         ORDER BY at DESC
         LIMIT 500`,
      )
      .all(roomId, roomId),
  )
  // Bounded (newest 500 tool calls): a long-lived room must not scan its whole history on every request.
  const seen = new Set<string>()
  for (const row of rows) {
    if (!FILE_TOOL.test(row.tool)) continue
    const path = pathFromPreview(row.preview, root)
    if (path !== null) seen.add(path)
    if (seen.size >= FILE_LIMIT) break
  }
  return [...seen]
}

export function roomLearned(sqlite: DatabaseSync, roomId: string) {
  const rows = z.array(LearnedRowSchema).parse(
    sqlite
      .prepare(
        `SELECT data, ts FROM events
          WHERE type = 'memory.saved' AND json_extract(data, '$.source.kind') = 'room'
            AND json_extract(data, '$.source.roomId') = ?
          ORDER BY seq DESC LIMIT ?`,
      )
      .all(roomId, LEARNED_LIMIT),
  )
  return rows.map((row) => {
    const data = LearnedDataSchema.parse(JSON.parse(row.data))
    return { text: data.text, savedTo: data.agentIds, at: row.ts }
  })
}
