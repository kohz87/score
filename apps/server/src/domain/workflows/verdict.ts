import { WORKFLOW_LIMITS, type VerdictRecord } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { redact } from '../../redact.ts'

// Verdicts and results of workflow attempts (design v8 "Verdicts and results"). The verdict is parsed from the COMPLETE
// sanitized final reply before any truncation, and only for attempts the runtime terminated. The stored output is cut
// afterwards and says so. Recovered or incomplete observations never produce a verdict.

const BlockSchema = z
  .object({
    verdict: z.enum(['passed', 'changes_requested']),
    reason: z.string().max(WORKFLOW_LIMITS.verdictReasonChars),
  })
  .strict()

const OPEN = /```score-verdict/g
const BLOCK = /```score-verdict[ \t]*\r?\n([\s\S]*?)\r?\n```/g

/**
 * Exactly one fenced `score-verdict` block with a valid body. Zero, several (an extra opening marker counts even when it
 * is unterminated or malformed) or an invalid body: no verdict.
 */
export function parseVerdict(
  sanitizedReply: string,
): { verdict: 'passed' | 'changes_requested'; reason: string } | null {
  const opens = [...sanitizedReply.matchAll(OPEN)].length
  const blocks = [...sanitizedReply.matchAll(BLOCK)]
  if (opens !== 1 || blocks.length !== 1) return null
  try {
    return BlockSchema.parse(JSON.parse(blocks[0]![1]!))
  } catch {
    return null
  }
}

/** Cuts at a code-point boundary within `limit` UTF-8 bytes. */
export function cutBytes(text: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= limit) return { text, truncated: false }
  let out = ''
  let size = 0
  for (const char of text) {
    size += Buffer.byteLength(char)
    if (size > limit) break
    out += char
  }
  return { text: out, truncated: true }
}

export interface ResultFacts {
  verdict: VerdictRecord | null
  output: string
  truncated: boolean
  fullBytes: number
}

/** Sanitizes the whole reply, parses the verdict from it, then bounds the stored output. */
export function resultFacts(fullReply: string): ResultFacts {
  const sanitized = redact(fullReply.replaceAll('\0', ''))
  const parsed = parseVerdict(sanitized)
  const cut = cutBytes(sanitized, WORKFLOW_LIMITS.outputBytes)
  return {
    verdict: parsed
      ? {
          verdict: parsed.verdict,
          reason: parsed.reason,
          source: 'runtime',
          outputTruncated: cut.truncated,
        }
      : null,
    output: cut.text,
    truncated: cut.truncated,
    fullBytes: Buffer.byteLength(sanitized),
  }
}

/**
 * Called from the ingest transaction that records a runtime-terminal status (`completed` / `failed`) of a run: if the
 * run is a workflow step attempt, its complete-reply facts are stored for the executor. Recovered text never passes here.
 */
export function recordRunResult(
  sqlite: DatabaseSync,
  runId: string,
  fullReply: string | null,
  now: string,
): void {
  if (fullReply === null) return
  const mapping = sqlite
    .prepare(
      `SELECT mr.orchestration_attempt_id AS attempt FROM message_runs mr
       JOIN orc_attempts a ON a.id = mr.orchestration_attempt_id
       JOIN orchestrations o ON o.id = a.orchestration_id
       WHERE mr.run_id = ? AND o.planner = 'workflow' AND a.kind = 'step'`,
    )
    .get(runId) as { attempt: string } | undefined
  if (!mapping) return
  const facts = resultFacts(fullReply)
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO wf_results (attempt_id, verdict, output, truncated, full_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      mapping.attempt,
      facts.verdict ? JSON.stringify(facts.verdict) : null,
      facts.output,
      facts.truncated ? 1 : 0,
      facts.fullBytes,
      now,
    )
}
