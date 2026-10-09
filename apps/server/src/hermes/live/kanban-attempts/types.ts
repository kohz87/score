import { z } from 'zod'

/** Stage 1 of 5.17a-1 runs only when SCORE_KANBAN_ATTEMPTS=1; everything else about Kanban is unchanged. */
export function kanbanAttemptsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SCORE_KANBAN_ATTEMPTS === '1'
}

// Bounds from design v5 §I.
export const ATTEMPT_PAGE = 200
export const EVENT_PAGE = 500
export const EVIDENCE_EVENT_LIMIT = 5000
export const SAMPLE_SIZE = 50
export const SWEEP_EVERY_MS = 5_000
export const FULLPASS_EVERY_MS = 10_000
export const PAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const UNREADABLE_AFTER = 3

export const CAPTURE_KINDS = ['baseline', 'tail', 'sweep', 'fullpass'] as const
export type CaptureKind = (typeof CAPTURE_KINDS)[number]

const Text = z.string().nullable()
const Int = z.int().nullable()

/** A Hermes `task_runs` row, as far as the projection uses it. */
export const HermesAttemptSchema = z.object({
  id: z.int().positive(),
  task_id: z.string().min(1),
  profile: Text,
  status: z.string(),
  claim_lock: Text,
  worker_pid: Int,
  // INTEGER affinity also holds restart-stable text fingerprints in current Hermes.
  worker_started_at: z.union([z.int(), z.string()]).nullable(),
  started_at: z.int(),
  ended_at: Int,
  outcome: Text,
  summary: Text,
  error: Text,
})
export type HermesAttempt = z.infer<typeof HermesAttemptSchema>

export const HermesEvidenceEventSchema = z.object({
  id: z.int().positive(),
  task_id: z.string(),
  run_id: Int,
  kind: z.string(),
  // Only `claimed` payloads are read; every other kind comes back NULL.
  payload: Text,
  created_at: z.int(),
})
export type HermesEvidenceEvent = z.infer<typeof HermesEvidenceEventSchema>

export const HermesTaskRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  assignee: Text,
  started_at: Int,
})
export type HermesTaskRow = z.infer<typeof HermesTaskRowSchema>

export interface Marks {
  /** `sqlite_sequence` high-water marks; null = no row. */
  eventSeq: number | null
  runSeq: number | null
  eventMin: number | null
  eventMax: number | null
  runMin: number | null
  runMax: number | null
}

export interface Capture {
  /** Minted when the read is taken; reused only when the very same captured page is retried. */
  captureId: string
  kind: CaptureKind
  historyId: string
  sourceId: string
  capturedAt: string
  /** `incarnationOf(path)` of the connection that served the read. */
  fileIdentity: string
  /** null = the sequence table could not be read. */
  marks: Marks | null
  events: { id: number; runId: number | null }[]
  eventFrom: number | null
  eventTo: number | null
  /** Highest event id scanned, malformed rows included. */
  eventScanned: number | null
  attempts: HermesAttempt[]
  /** Attempt ids the read asked for explicitly (sweep, tail-touched, sample). */
  requestedIds: number[]
  /** Range reads (baseline/fullpass): the id window the page covers; `to` null = to the end of the table. */
  range: { from: number; to: number | null } | null
  sample: HermesAttempt[]
  sampleIds: number[]
  evidenceEvents: HermesEvidenceEvent[]
  evidenceTruncated: boolean
  tasks: HermesTaskRow[]
  malformed: number
}
