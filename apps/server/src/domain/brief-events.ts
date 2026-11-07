import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { DeriveEvents } from '../hub/ingest.ts'
import { readBriefRow, projectedDetail } from './brief-queries.ts'
import { recordEdge, linkTask } from './brief-links.ts'
import { emitBrief } from './brief-status.ts'
import { recordArrivalHolds } from './brief-holds.ts'

function briefIdsFor(sqlite: DatabaseSync, sql: string, value: string): string[] {
  return z
    .array(z.object({ brief_id: z.string() }))
    .parse(sqlite.prepare(sql).all(value))
    .map((row) => row.brief_id)
}
const forMessage = (sqlite: DatabaseSync, id: string) =>
  briefIdsFor(sqlite, 'SELECT chain_id AS brief_id FROM message_runs WHERE message_id = ?', id)
const forRun = (sqlite: DatabaseSync, id: string) => [
  ...briefIdsFor(sqlite, 'SELECT chain_id AS brief_id FROM message_runs WHERE run_id = ?', id),
  ...briefIdsFor(
    sqlite,
    `SELECT b.brief_id FROM brief_tasks b JOIN task_projections p ON p.id = b.task_id WHERE EXISTS
     (SELECT 1 FROM json_each(json_extract(p.detail, '$.runIds')) WHERE value = ?)`,
    id,
  ),
]
const forTask = (sqlite: DatabaseSync, id: string) =>
  briefIdsFor(sqlite, 'SELECT brief_id FROM brief_tasks WHERE task_id = ?', id)

// Ingest hook: keeps the brief tables in step with the events an observation produced, and emits
// `brief.upserted` when a brief's derived status changed. Same transaction as the observation itself.
export const deriveBriefEvents: DeriveEvents = (sqlite, drafts, { now }) => {
  const affected = new Set<string>()
  const add = (ids: string[]) => ids.forEach((id) => affected.add(id))
  const explicit = new Set<string>()
  const arrived = new Set<string>()
  for (const draft of drafts) {
    switch (draft.type) {
      case 'brief.upserted':
        explicit.add(draft.data.id)
        break
      case 'message.created':
      case 'message.delta':
      case 'typing':
        break
      case 'message.completed':
        add(forMessage(sqlite, draft.data.messageId))
        break
      case 'run.updated':
        add(forRun(sqlite, draft.data.id))
        for (const ref of draft.data.refs) if (ref.kind === 'task') add(forTask(sqlite, ref.taskId))
        break
      case 'task.upserted': {
        const detail = projectedDetail(sqlite, draft.data.id)
        for (const parent of detail?.dependsOn ?? [])
          for (const briefId of forTask(sqlite, parent))
            linkTask(sqlite, briefId, draft.data.id, 'child', now)
        add(forTask(sqlite, draft.data.id))
        arrived.add(draft.data.id)
        break
      }
      case 'approval.requested':
      case 'approval.updated':
        for (const ref of draft.data.refs) {
          if (ref.kind === 'task') add(forTask(sqlite, ref.taskId))
          if (ref.kind === 'run') add(forRun(sqlite, ref.runId))
        }
        break
      case 'handoff.created': {
        const { briefId, handoff } = draft.data
        if (briefId && readBriefRow(sqlite, briefId)) {
          recordEdge(sqlite, briefId, handoff, handoff.from.blockId, handoff.to.blockId)
          add([briefId])
        }
        break
      }
      case 'lane.upserted': {
        const { briefId, block } = draft.data
        if (!briefId || !readBriefRow(sqlite, briefId)) break
        const turn = block.runId
          ? z
              .object({ message_id: z.string() })
              .optional()
              .parse(
                sqlite
                  .prepare('SELECT message_id FROM message_runs WHERE run_id = ?')
                  .get(block.runId),
              )
          : undefined
        const node = block.taskId
          ? `task:${block.taskId}`
          : turn
            ? `turn:${turn.message_id}`
            : undefined
        if (node)
          sqlite
            .prepare(
              `INSERT INTO brief_blocks (brief_id, block_id, node_id) VALUES (?, ?, ?)
               ON CONFLICT (brief_id, block_id) DO UPDATE SET node_id = excluded.node_id`,
            )
            .run(briefId, block.id, node)
        add([briefId])
        break
      }
      default:
        break
    }
  }
  recordArrivalHolds(sqlite, arrived, now)
  return [...affected].filter((id) => !explicit.has(id)).flatMap((id) => emitBrief(sqlite, id))
}
