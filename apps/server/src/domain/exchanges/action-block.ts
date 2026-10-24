import { ExchangeActionSchema, type ExchangeAction } from '@score/contract'
import type { z } from 'zod'

export type ScoreActionBlock =
  | { kind: 'none' }
  | { kind: 'action'; action: ExchangeAction }
  | { kind: 'invalid'; notice: string }

// Same rule as parseVerdict: an extra opening marker counts even when it is unterminated or malformed. The parser is
// pure and the notice never repeats any of the reply: the block may hold private or unsafe text.
const OPEN = /```score-action/g
const BLOCK = /```score-action[ \t]*\r?\n([\s\S]*?)\r?\n```/g
const NOTICE = "Score ignored this reply's action: "
const FIELDS = new Set(['note', 'question', 'text', 'to', 'replaces'])

const invalid = (reason: string): ScoreActionBlock => ({ kind: 'invalid', notice: NOTICE + reason })

/** Names the first field at fault, only when it is one of the action's own fields (never echoes a value). */
function issueDetail(issues: readonly z.core.$ZodIssue[]): string | null {
  const issue = issues[0]
  const field = typeof issue?.path[0] === 'string' ? issue.path[0] : null
  if (!issue || field === null || !FIELDS.has(field)) return null
  return issue.code === 'invalid_type' && issue.input === undefined
    ? `${field} is required`
    : `${field} wasn't valid`
}

/** Reads exactly one complete `score-action` block from a sanitized final reply. */
export function parseScoreAction(sanitizedReply: string): ScoreActionBlock {
  const opens = [...sanitizedReply.matchAll(OPEN)].length
  if (opens === 0) return { kind: 'none' }
  if (opens !== 1) return invalid(`it had ${opens} score-action blocks.`)

  const blocks = [...sanitizedReply.matchAll(BLOCK)]
  if (blocks.length !== 1) return invalid("the score-action block wasn't complete.")

  let value: unknown
  try {
    value = JSON.parse(blocks[0]![1]!)
  } catch {
    return invalid("the score-action block wasn't valid JSON.")
  }

  const parsed = ExchangeActionSchema.safeParse(value)
  if (!parsed.success) {
    const detail = issueDetail(parsed.error.issues)
    return invalid(
      detail === null ? "the action wasn't valid." : `the action wasn't valid (${detail}).`,
    )
  }
  return { kind: 'action', action: parsed.data }
}
