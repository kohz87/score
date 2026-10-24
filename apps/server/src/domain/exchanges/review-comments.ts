import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ExchangeAction } from '@score/contract'
import { z } from 'zod'
import { redact } from '../../redact.ts'
import { isCredentialPath } from '../watch-frames.ts'

type Commenting = Extract<ExchangeAction, { action: 'review' | 'approve' | 'send_back' }>

/** Stores an applied review action's line notes (PLAN 11.6a); text is redacted like every agent-written note. */
export function recordComments(
  sqlite: DatabaseSync,
  {
    jobId,
    turnId,
    agentId,
    exchangeId,
  }: { jobId: string; turnId: string; agentId: string; exchangeId: string | null },
  action: Commenting,
  now: string,
): void {
  const insert = sqlite.prepare(
    `INSERT INTO review_comments (id, job_id, exchange_id, turn_id, agent_id, action, path, line, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const comment of action.comments ?? [])
    insert.run(
      `rvc_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      jobId,
      exchangeId,
      turnId,
      agentId,
      action.action,
      comment.path,
      comment.line,
      // As Watch hides a credential file's diff, a note on one keeps only that it exists.
      isCredentialPath(comment.path)
        ? 'A note on a credential file (hidden).'
        : redact(comment.text),
      now,
    )
}

const CommentRowSchema = z.object({
  id: z.string(),
  exchange_id: z.string().nullable(),
  agent_id: z.string(),
  action: z.enum(['review', 'approve', 'send_back']),
  path: z.string(),
  line: z.int().positive(),
  text: z.string(),
  created_at: z.string(),
})

export function jobComments(sqlite: DatabaseSync, jobId: string) {
  return z
    .array(CommentRowSchema)
    .parse(
      sqlite
        .prepare('SELECT * FROM review_comments WHERE job_id = ? ORDER BY created_at, rowid')
        .all(jobId),
    )
}
