import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  AgentQuestionAnswerSchema,
  AgentQuestionSchema,
  type AgentQuestion,
  type AgentQuestionAnswer,
} from '@score/contract'
import { HttpError } from '../errors.ts'
import { redactBounded } from '../redact.ts'
import type { DomainEventDraft } from '../hub/ingest.ts'

// 2.3.0 (decision 128): an agent's clarify question to the person (Hermes `clarify.request` on a Score run). Its own
// table, never an approval: nothing but the person (or Hermes timing out) answers it.

const RowSchema = z.object({
  id: z.string(),
  profile: z.string(),
  run_id: z.string(),
  prompt_id: z.string(),
  generation: z.int().nullable(),
  room_id: z.string().nullable(),
  job_id: z.string().nullable(),
  question: z.string(),
  options: z.string(),
  multi_select: z.int(),
  status: z.enum(['pending', 'answered', 'expired', 'withdrawn']),
  answer: z.string().nullable(),
  answered_by: z.enum(['you', 'elsewhere', 'timeout']).nullable(),
  delivery: z.enum(['none', 'delivering', 'applied', 'failed']),
  created_at: z.string(),
  expires_at: z.string().nullable(),
  answered_at: z.string().nullable(),
  updated_at: z.string(),
})
export type QuestionRow = z.infer<typeof RowSchema>

export function toQuestion(row: QuestionRow): AgentQuestion {
  return AgentQuestionSchema.parse({
    id: row.id,
    agentId: row.profile,
    runId: row.run_id,
    roomId: row.room_id,
    jobId: row.job_id,
    question: row.question,
    options: z.array(z.string()).parse(JSON.parse(row.options)),
    multiSelect: row.multi_select === 1,
    status: row.status,
    answer: row.answer === null ? null : AgentQuestionAnswerSchema.parse(JSON.parse(row.answer)),
    answeredBy: row.answered_by,
    delivery: row.delivery,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    answeredAt: row.answered_at,
  })
}

export function readQuestionRow(sqlite: DatabaseSync, id: string): QuestionRow | null {
  const row = sqlite.prepare('SELECT * FROM agent_questions WHERE id = ?').get(id)
  return row === undefined ? null : RowSchema.parse(row)
}

export function readQuestion(sqlite: DatabaseSync, id: string): AgentQuestion {
  const row = readQuestionRow(sqlite, id)
  if (!row) throw new HttpError(404, 'not_found', 'Couldn’t find that question.')
  return toQuestion(row)
}

export function listQuestions(
  sqlite: DatabaseSync,
  filter: { status: 'pending' | 'all'; roomId?: string },
): AgentQuestion[] {
  const rows = sqlite
    .prepare(
      `SELECT * FROM agent_questions WHERE (? = 'all' OR status = 'pending') AND (? IS NULL OR room_id = ?)
       ORDER BY created_at DESC, id DESC LIMIT 200`,
    )
    .all(filter.status, filter.roomId ?? null, filter.roomId ?? null)
  return rows.map((row) => toQuestion(RowSchema.parse(row)))
}

const draft = (sqlite: DatabaseSync, id: string, requested = false): DomainEventDraft => ({
  type: requested ? 'question.requested' : 'question.updated',
  data: readQuestion(sqlite, id),
})

/** A `clarify.request` on a Score run: recorded once per (run, prompt); a replayed event changes nothing. */
export function requestRunQuestion(
  sqlite: DatabaseSync,
  req: {
    profile: string
    runId: string
    promptId: string
    generation: number | null
    question: string
    options: string[]
    multiSelect: boolean
    expiresAt: string | null
  },
  at: string,
): DomainEventDraft[] {
  const existing = sqlite
    .prepare('SELECT id FROM agent_questions WHERE run_id = ? AND prompt_id = ?')
    .get(req.runId, req.promptId) as { id: string } | undefined
  if (existing) return []
  const owner = sqlite
    .prepare('SELECT room_id, job_id FROM message_runs WHERE run_id = ? LIMIT 1')
    .get(req.runId) as { room_id: string; job_id: string | null } | undefined
  const id = randomUUID()
  const options = req.options.map((option) => redactBounded(option, 512)).slice(0, 50)
  sqlite
    .prepare(
      `INSERT INTO agent_questions (id, profile, run_id, prompt_id, generation, room_id, job_id, question, options,
         multi_select, created_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      req.profile,
      req.runId,
      req.promptId,
      req.generation,
      owner?.room_id ?? null,
      owner?.job_id ?? null,
      redactBounded(req.question, 8192),
      JSON.stringify(options),
      req.multiSelect && options.length > 0 ? 1 : 0,
      at,
      req.expiresAt,
      at,
    )
  return [draft(sqlite, id, true)]
}

function patch(
  sqlite: DatabaseSync,
  id: string,
  values: Partial<
    Pick<QuestionRow, 'status' | 'answer' | 'answered_by' | 'delivery' | 'answered_at'>
  >,
  at: string,
): DomainEventDraft[] {
  const keys = Object.keys(values)
  if (!keys.length) return []
  sqlite
    .prepare(
      `UPDATE agent_questions SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    )
    .run(...keys.map((key) => values[key as keyof typeof values] ?? null), at, id)
  return [draft(sqlite, id)]
}

/** Hermes settled the prompt (answered anywhere, timed out or withdrawn): a question Score didn't answer closes. */
export function settleRunQuestion(
  sqlite: DatabaseSync,
  runId: string,
  promptId: string,
  at: string,
): DomainEventDraft[] {
  const row = sqlite
    .prepare('SELECT * FROM agent_questions WHERE run_id = ? AND prompt_id = ?')
    .get(runId, promptId)
  if (row === undefined) return []
  const question = RowSchema.parse(row)
  if (question.status !== 'pending' || question.delivery === 'delivering') return []
  const timedOut =
    question.expires_at !== null && Date.parse(question.expires_at) <= Date.parse(at) + 1000
  return patch(
    sqlite,
    question.id,
    timedOut
      ? { status: 'expired', answered_by: 'timeout', answered_at: at }
      : { status: 'withdrawn', answered_by: 'elsewhere', answered_at: at },
    at,
  )
}

/** The run ended: whatever it still asked is withdrawn. */
export function closeRunQuestions(
  sqlite: DatabaseSync,
  runId: string,
  at: string,
): DomainEventDraft[] {
  const ids = sqlite
    .prepare(
      "SELECT id FROM agent_questions WHERE run_id = ? AND status = 'pending' AND delivery != 'delivering'",
    )
    .all(runId) as { id: string }[]
  return ids.flatMap(({ id }) => patch(sqlite, id, { status: 'withdrawn', answered_at: at }, at))
}

/** Checks an answer against the question; returns the text Hermes receives (a JSON array for a multi-select). */
export function answerText(question: QuestionRow, answer: AgentQuestionAnswer): string {
  const options = z.array(z.string()).parse(JSON.parse(question.options))
  const bad = (message: string) => new HttpError(400, 'bad_request', message)
  if (options.length === 0) {
    if (typeof answer !== 'string') throw bad('This question takes a written answer.')
    return answer
  }
  if (question.multi_select === 1) {
    const picked = typeof answer === 'string' ? [answer] : answer
    if (new Set(picked).size !== picked.length || picked.some((value) => !options.includes(value)))
      throw bad('Pick from the options the agent offered.')
    return JSON.stringify(picked)
  }
  if (typeof answer !== 'string' || !options.includes(answer))
    throw bad('Pick one of the options the agent offered.')
  return answer
}

/** The person answers: checked, marked delivering (one delivery at a time), and the text to send returned. */
export function beginAnswer(
  sqlite: DatabaseSync,
  id: string,
  answer: AgentQuestionAnswer,
  at: string,
): { row: QuestionRow; text: string; drafts: DomainEventDraft[] } {
  const row = readQuestionRow(sqlite, id)
  if (!row) throw new HttpError(404, 'not_found', 'Couldn’t find that question.')
  if (row.status !== 'pending' || row.delivery === 'delivering')
    throw new HttpError(
      409,
      'conflict',
      'This question is no longer waiting for an answer.',
      toQuestion(row),
    )
  const text = answerText(row, answer)
  const drafts = patch(sqlite, id, { delivery: 'delivering', answer: JSON.stringify(answer) }, at)
  return { row: readQuestionRow(sqlite, id)!, text, drafts }
}

/** Hermes' word on the delivery. `resolved`: answered; `gone`: Hermes no longer waited; `failed`: try again. */
export function finishAnswer(
  sqlite: DatabaseSync,
  id: string,
  outcome: 'resolved' | 'gone' | 'failed',
  at: string,
): DomainEventDraft[] {
  if (outcome === 'resolved')
    return patch(
      sqlite,
      id,
      { status: 'answered', answered_by: 'you', delivery: 'applied', answered_at: at },
      at,
    )
  if (outcome === 'gone')
    return patch(
      sqlite,
      id,
      { status: 'withdrawn', answer: null, delivery: 'failed', answered_at: at },
      at,
    )
  return patch(sqlite, id, { delivery: 'failed', answer: null }, at)
}

/** At start: a delivery Score was making when it stopped is unknown, so the person may answer again. */
export function resetInterruptedAnswers(sqlite: DatabaseSync, at: string): void {
  sqlite
    .prepare(
      "UPDATE agent_questions SET delivery = 'failed', answer = NULL, updated_at = ? WHERE delivery = 'delivering'",
    )
    .run(at)
}
