import type { DatabaseSync } from 'node:sqlite'
import type { Workbench } from '@score/contract'
import { z } from 'zod'
import { readFrame } from '../watch-frames.ts'
import { jobResults } from './results.ts'
import { jobComments } from './review-comments.ts'
import { replayWorkbench, type CommentEvent, type EditEvent } from './workbench-replay.ts'

// A job's Workbench (PLAN 11.6a), derived on read: editor frames of the job's runs replayed into per-line authorship,
// the job's review notes placed on those lines, the drafts and each agent's newest screen from Results.

const MAX_FRAMES = 2000

const EditorPayloadSchema = z.object({
  path: z.string().min(1),
  diff: z.string(),
  language: z.string().nullable().optional(),
})

export function jobWorkbench(sqlite: DatabaseSync, jobId: string): Omit<Workbench, 'asOfSeq'> {
  // jobResults also answers 404 for an unknown job.
  const results = jobResults(sqlite, jobId)
  // In recording order (rowid breaks ties between agents, whose seq counters are separate), and bounded: a job with
  // more edits than this shows the first ones and says the rest isn't exact.
  const rows = sqlite
    .prepare(
      `SELECT agent_id, seq, at, payload FROM watch_frames
         WHERE surface = 'editor'
           AND run_id IN (SELECT run_id FROM message_runs WHERE job_id = ? AND run_id IS NOT NULL)
         ORDER BY at, rowid LIMIT ?`,
    )
    .all(jobId, MAX_FRAMES + 1) as { agent_id: string; seq: number; at: string; payload: string }[]
  const capped = rows.length > MAX_FRAMES
  if (capped) rows.length = MAX_FRAMES
  const edits: EditEvent[] = []
  rows.forEach((row, order) => {
    let editor: z.infer<typeof EditorPayloadSchema>
    try {
      editor = EditorPayloadSchema.parse(JSON.parse(row.payload))
    } catch {
      return
    }
    edits.push({
      kind: 'edit',
      at: row.at,
      order,
      agentId: row.agent_id,
      path: editor.path,
      diff: editor.diff,
      language: editor.language ?? null,
    })
  })
  const comments: CommentEvent[] = jobComments(sqlite, jobId).map((row, order) => ({
    kind: 'comment',
    at: row.created_at,
    order,
    id: row.id,
    agentId: row.agent_id,
    path: row.path,
    line: row.line,
    text: row.text,
    exchangeId: row.exchange_id,
    action: row.action,
  }))
  const replay = replayWorkbench(edits, comments)
  const files = capped ? replay.files.map((file) => ({ ...file, exact: false })) : replay.files
  const { looseComments } = replay
  const screens: Workbench['screens'] = []
  for (const screen of results.screens) {
    const frame = readFrame(sqlite, screen.agentId, screen.seq)
    if (frame) screens.push({ frame, live: screen.live })
  }
  return {
    files,
    looseComments,
    drafts: results.items.flatMap((item) => (item.kind === 'draft' ? [item] : [])),
    screens,
  }
}
