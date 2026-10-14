import { WORKFLOW_LIMITS, type VerdictRecord } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { redact } from '../../redact.ts'
import { addCodingStored } from '../orchestration/ops.ts'

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
  /** The reply is over the verdict input limit: no verdict is read, and the step fails (7.7c §3). */
  tooLong: boolean
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
    tooLong: false,
  }
}

/**
 * A coding agent's reply is read whole up to the verdict input limit. Over it, the output is cut for display and no
 * verdict is looked for at all: a prefix would answer a different question than the whole reply does.
 */
export function codingResultFacts(rawReply: string): ResultFacts {
  const bytes = Buffer.byteLength(rawReply)
  if (bytes <= WORKFLOW_LIMITS.verdictInputBytes) return resultFacts(rawReply)
  const cut = cutBytes(redact(rawReply.replaceAll('\0', '')), WORKFLOW_LIMITS.outputBytes)
  return { verdict: null, output: cut.text, truncated: true, fullBytes: bytes, tooLong: true }
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
      `SELECT mr.orchestration_attempt_id AS attempt, mr.generation AS generation, a.runtime AS runtime, o.id AS orchestration
       FROM message_runs mr
       JOIN orc_attempts a ON a.id = mr.orchestration_attempt_id
       JOIN orchestrations o ON o.id = a.orchestration_id
       WHERE mr.run_id = ? AND o.planner = 'workflow' AND a.kind = 'step'`,
    )
    .get(runId) as
    | { attempt: string; generation: number | null; runtime: string; orchestration: string }
    | undefined
  if (!mapping) return
  const coding = mapping.runtime !== 'hermes'
  // A coding attempt's facts belong to the dispatch generation whose run this is (7.7c §3); Hermes attempts have one row.
  const generation = coding ? (mapping.generation ?? 0) : 0
  const facts = coding ? codingResultFacts(fullReply) : resultFacts(fullReply)
  const verdict = facts.verdict ? JSON.stringify(facts.verdict) : null
  if (!coding) {
    sqlite
      .prepare(
        `INSERT OR REPLACE INTO wf_results (attempt_id, generation, verdict, output, truncated, full_bytes, too_long, created_at) VALUES (?, 0, ?, ?, ?, ?, 0, ?)`,
      )
      .run(mapping.attempt, verdict, facts.output, facts.truncated ? 1 : 0, facts.fullBytes, now)
    return
  }
  // Once per (attempt, generation); the row is coding inventory, so it is charged to the run's coding partition (§5).
  const written = sqlite
    .prepare(
      `INSERT INTO wf_results (attempt_id, generation, verdict, output, truncated, full_bytes, too_long, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (attempt_id, generation) DO NOTHING`,
    )
    .run(
      mapping.attempt,
      generation,
      verdict,
      facts.output,
      facts.truncated ? 1 : 0,
      facts.fullBytes,
      facts.tooLong ? 1 : 0,
      now,
    )
  if (Number(written.changes) > 0)
    addCodingStored(
      sqlite,
      mapping.orchestration,
      Buffer.byteLength(facts.output) + Buffer.byteLength(verdict ?? ''),
    )
}
