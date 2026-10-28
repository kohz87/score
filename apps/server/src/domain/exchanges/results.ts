import type { DatabaseSync } from 'node:sqlite'
import { ExchangeActionSchema, type JobResults, type ResultCard } from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import { redact } from '../../redact.ts'
import { messageFromRow } from '../rooms.ts'
import { jobRow } from './store.ts'

// A job's results (PLAN 11.2b, docs/briefs/11.0-bold.md §10), derived on read from what Score already records for the
// job's turns: the files agents changed (`file` parts), the outcomes of its reviews (applied approve / send_back
// actions), the watch frames of its runs and the documents agents attached. Nothing is stored twice.

const FrameRowSchema = z.object({
  agent_id: z.string(),
  seq: z.int(),
  at: z.string(),
  run_id: z.string().nullable(),
  surface: z.enum(['terminal', 'editor', 'browser']),
  caption: z.string(),
})

type ChangeState = Extract<ResultCard, { kind: 'change' }>['state']

/** Where the change stands: the job's latest review decides, else the job itself. */
function changeState(
  review: { state: string; outcome: string | null } | undefined,
  job: string,
): ChangeState {
  if (review?.outcome === 'approved') return 'approved'
  if (review?.state === 'waiting_on_agent') return 'sent_back'
  if (review?.state === 'live') return 'in_review'
  if (job === 'working') return 'working'
  return !review && job === 'done' ? 'done' : 'waiting_on_you'
}

const firstLine = (text: string) =>
  redact(text.split('\n').find((line) => line.trim()) ?? '')
    .trim()
    .slice(0, 200)

/**
 * 3.14 (owner: "the workbench and work tabs are always empty"): the jobs whose turns count for this one. A job started
 * as an orchestration or a recipe run is a link; the run's turns are recorded on its own room's job, so they count too.
 */
export function jobScope(sqlite: DatabaseSync, jobId: string): string[] {
  const job = sqlite.prepare('SELECT recipe_kind, recipe_ref FROM jobs WHERE id = ?').get(jobId) as
    { recipe_kind: string | null; recipe_ref: string | null } | undefined
  if (!job?.recipe_ref || !['orchestration', 'workflow'].includes(job.recipe_kind ?? ''))
    return [jobId]
  const run = sqlite
    .prepare('SELECT room_id FROM orchestrations WHERE id = ?')
    .get(job.recipe_ref) as { room_id: string } | undefined
  if (!run) return [jobId]
  const linked = (
    sqlite
      .prepare('SELECT id FROM jobs WHERE room_id = ? AND deleted_at IS NULL')
      .all(run.room_id) as {
      id: string
    }[]
  ).map((row) => row.id)
  return [...new Set([jobId, ...linked])]
}

/** `?, ?, …` for an IN list. */
export const marks = (ids: readonly string[]): string => ids.map(() => '?').join(', ')

/** Lines added and removed in a unified diff (headers and hunk lines excluded). */
export function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

export function jobResults(sqlite: DatabaseSync, jobId: string): Omit<JobResults, 'asOfSeq'> {
  const job = jobRow(sqlite, jobId)
  if (!job) throw new HttpError(404, 'not_found', 'Couldn’t find that job.')
  const scope = jobScope(sqlite, jobId)
  const room = sqlite.prepare('SELECT name FROM rooms WHERE id = ?').get(job.room_id) as {
    name: string
  }
  const messages = sqlite
    .prepare(
      `SELECT * FROM messages WHERE job_id IN (${marks(scope)}) AND deleted_at IS NULL AND author_kind = 'agent' ORDER BY created_at, id`,
    )
    .all(...scope)
    .map(messageFromRow)
  const items: ResultCard[] = []

  // The change: files per path (who touched them), and what the reviews said about it.
  const files = new Map<string, { added: number; removed: number; by: Set<string> }>()
  let lastChange: string | null = null
  for (const message of messages)
    for (const part of message.parts) {
      if (part.kind !== 'file' || message.author.kind !== 'agent') continue
      const file = files.get(part.path) ?? { added: 0, removed: 0, by: new Set<string>() }
      file.added += part.added
      file.removed += part.removed
      file.by.add(message.author.agentId)
      files.set(part.path, file)
      lastChange = message.createdAt
    }
  // Agents that edit through their own tools (Hermes's patch and write_file) leave no file parts; the editor frames Watch
  // recorded for the job's runs say which files changed, and their diffs how much (3.14).
  {
    // Paths a file part already reports keep its numbers; frames add the paths no part named (review).
    const reported = new Set(files.keys())
    const edits = sqlite
      .prepare(
        `SELECT agent_id, at, payload FROM watch_frames WHERE surface = 'editor'
           AND run_id IN (SELECT run_id FROM message_runs WHERE job_id IN (${marks(scope)}) AND run_id IS NOT NULL)
         ORDER BY at, rowid LIMIT 2000`,
      )
      .all(...scope) as { agent_id: string; at: string; payload: string }[]
    for (const edit of edits) {
      let payload: { path?: unknown; diff?: unknown }
      try {
        payload = JSON.parse(edit.payload) as { path?: unknown; diff?: unknown }
      } catch {
        continue
      }
      if (typeof payload.path !== 'string' || payload.path === '' || reported.has(payload.path))
        continue
      const counts = diffCounts(typeof payload.diff === 'string' ? payload.diff : '')
      const file = files.get(payload.path) ?? { added: 0, removed: 0, by: new Set<string>() }
      file.added += counts.added
      file.removed += counts.removed
      file.by.add(edit.agent_id)
      files.set(payload.path, file)
      lastChange = edit.at
    }
  }
  const outcomes = z
    .array(
      z.object({
        args: z.string().transform((value) => ExchangeActionSchema.parse(JSON.parse(value))),
        agent_id: z.string(),
        exchange_id: z.string().nullable(),
        created_at: z.string(),
      }),
    )
    .parse(
      sqlite
        .prepare(
          `SELECT a.args, mr.agent_id, mr.exchange_id, a.created_at
           FROM exchange_actions a JOIN message_runs mr ON mr.turn_id = a.turn_id
           WHERE mr.job_id IN (${marks(scope)}) AND a.state = 'applied' AND a.action IN ('approve', 'send_back')
           ORDER BY a.created_at, a.turn_id`,
        )
        .all(...scope),
    )
  const review = sqlite
    .prepare(
      `SELECT state, outcome FROM exchanges WHERE job_id IN (${marks(scope)}) AND kind = 'review' ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(...scope) as { state: string; outcome: string | null } | undefined
  if (files.size || outcomes.length) {
    items.push({
      kind: 'change',
      id: `change:${jobId}`,
      title: job.is_default ? room.name : job.title,
      authors: [...new Set([...files.values()].flatMap((file) => [...file.by]))].sort(),
      state: changeState(review, job.state),
      // A send-back that an approval of the same review settled is something the reviewer caught.
      whatChanged: outcomes.map(({ args, agent_id, exchange_id }) =>
        args.action === 'approve'
          ? { text: `Approved by ${agent_id}`, by: agent_id, caught: false }
          : {
              text: firstLine(args.action === 'send_back' ? args.note : ''),
              by: agent_id,
              caught: outcomes.some(
                (other) => other.args.action === 'approve' && other.exchange_id === exchange_id,
              ),
            },
      ),
      files: [...files.entries()]
        .map(([path, file]) => ({
          path,
          added: file.added,
          removed: file.removed,
          by: [...file.by].sort(),
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      at: outcomes.at(-1)?.created_at ?? lastChange ?? job.updated_at,
    })
  }

  // Frames of the job's runs: the newest browser frame is the preview; each agent's newest frame is its screen.
  const frames = z.array(FrameRowSchema).parse(
    sqlite
      .prepare(
        `SELECT f.agent_id, f.seq, f.at, f.run_id, f.surface, f.caption FROM watch_frames f
           WHERE f.run_id IN (SELECT run_id FROM message_runs WHERE job_id IN (${marks(scope)}) AND run_id IS NOT NULL)
           ORDER BY f.at DESC, f.seq DESC`,
      )
      .all(...scope),
  )
  const running = new Set(
    (
      sqlite
        .prepare(
          `SELECT run_id FROM message_runs WHERE job_id IN (${marks(scope)}) AND state = 'active' AND run_id IS NOT NULL`,
        )
        .all(...scope) as { run_id: string }[]
    ).map((row) => row.run_id),
  )
  // The newest browser frame whose page reads cleanly; payloads are loaded one at a time, newest first.
  const PageSchema = z
    .object({
      url: z.string(),
      title: z.string().nullable().optional(),
      imageUrl: z.string().nullable().optional(),
    })
    .loose()
  for (const frame of frames.filter((item) => item.surface === 'browser')) {
    const row = sqlite
      .prepare('SELECT payload FROM watch_frames WHERE agent_id = ? AND seq = ?')
      .get(frame.agent_id, frame.seq) as { payload: string } | undefined
    let page: z.infer<typeof PageSchema>
    try {
      page = PageSchema.parse(JSON.parse(row?.payload ?? 'null'))
    } catch {
      continue
    }
    items.push({
      kind: 'preview',
      id: `preview:${frame.agent_id}:${frame.seq}`,
      agentId: frame.agent_id,
      url: page.url,
      title: page.title ?? null,
      imageUrl: page.imageUrl ?? null,
      live: frame.run_id !== null && running.has(frame.run_id),
      at: frame.at,
    })
    break
  }

  // Drafts: documents and workspace files agents attached in the job.
  for (const message of messages)
    for (const part of message.parts) {
      if (message.author.kind !== 'agent') continue
      if (part.kind === 'document')
        items.push({
          kind: 'draft',
          id: `draft:${message.id}:${part.mediaId}`,
          agentId: message.author.agentId,
          title: part.name,
          target: { kind: 'document', mediaId: part.mediaId },
          at: message.createdAt,
        })
      if (part.kind === 'workspace')
        items.push({
          kind: 'draft',
          id: `draft:${message.id}:${part.path}`,
          agentId: message.author.agentId,
          title: part.path.split('/').at(-1) ?? part.path,
          target: { kind: 'workspace', path: part.path },
          at: message.createdAt,
        })
    }

  const screens = new Map<string, JobResults['screens'][number]>()
  for (const frame of frames)
    if (!screens.has(frame.agent_id))
      screens.set(frame.agent_id, {
        agentId: frame.agent_id,
        seq: frame.seq,
        surface: frame.surface,
        caption: redact(frame.caption),
        live: frame.run_id !== null && running.has(frame.run_id),
        at: frame.at,
      })
  return {
    items: items.sort((a, b) => b.at.localeCompare(a.at)),
    screens: [...screens.values()].sort((a, b) => a.agentId.localeCompare(b.agentId)),
  }
}
