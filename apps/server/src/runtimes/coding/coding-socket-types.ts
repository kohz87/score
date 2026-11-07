import { z } from 'zod'

// The Score side of the supervisor wire protocol (7.7a design v7 section 4). The supervisor side is supervisor.mjs.

export const PROTOCOL_VERSION = 1
export const MAX_FRAME_BYTES = 64 * 1024
export const MAX_CHUNK_BYTES = 32 * 1024
/** sun_path is 108 bytes including the terminating NUL; keep a margin. */
export const MAX_SOCKET_PATH_BYTES = 100

const Stream = z.enum(['stdout', 'stderr'])
export const SupervisorFrame = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    v: z.literal(PROTOCOL_VERSION),
    launch: z.string().min(1).max(128),
    generation: z.number().int().nonnegative(),
    token: z.string().min(1).max(256),
    specHash: z.string().min(1).max(128),
  }),
  z.object({
    t: z.literal('ready'),
    pid: z.number().int().positive(),
    start: z.string().regex(/^\d+$/),
    cgroup: z.string().min(1).max(1024),
  }),
  z.object({
    t: z.literal('out'),
    stream: Stream,
    seq: z.number().int().positive(),
    data: z.string().max(Math.ceil((MAX_CHUNK_BYTES * 4) / 3) + 4),
  }),
  z.object({
    t: z.literal('eof'),
    stream: Stream,
    lastSeq: z.number().int().nonnegative(),
    /** The supervisor closed its end of the pipe itself: unread output may be lost, so this is not a clean EOF. */
    forced: z.boolean().optional(),
  }),
  z.object({
    t: z.literal('exit'),
    code: z.number().int().nullable(),
    signal: z.string().max(32).nullable(),
  }),
  z.object({
    t: z.literal('end'),
    survivorsKilled: z.boolean().optional(),
    stopCause: z.string().max(64).nullable().optional(),
  }),
  z.object({ t: z.literal('error'), code: z.string().max(64) }),
])
export type SupervisorFrame = z.infer<typeof SupervisorFrame>

export interface ReadyInfo {
  pid: number
  start: string
  cgroup: string
}

export interface SessionOutcome {
  kind: 'ended' | 'lost'
  /** True only when the completeness rule holds (design section 4 "Completeness"): the result may be eligible. */
  eligible: boolean
  reasons: string[]
  exit: { code: number | null; signal: string | null } | null
  stopCause: string | null
  survivorsKilled: boolean
  /** Records dropped for size or because the last stdout line was partial at eof. */
  droppedRecords: number
  /** The `ack-end` frame reached the kernel's socket buffer (not merely queued): only then can the close be a normal one. */
  ackFlushed: boolean
}

export interface RunHandlers {
  /** One complete stdout record (a decoded line). Processed strictly in order; a throw/reject makes the run ineligible. */
  onStdoutRecord(line: string): void | Promise<void>
  /** Diagnostic stderr text (bounded, never parsed as records). */
  onStderr?(text: string): void
  /**
   * Score's side is about to stop the run on its own account (a broken bound, an ingestion failure, shutdown). Called
   * BEFORE the stop frame goes out so the cause can be made durable first (review 2026-10-12 #17). It must not throw.
   */
  onStop?(cause: string): void
  /** What the run keeps in memory besides queued records right now (the parser's retained values), in bytes. */
  retainedBytes?(): number
}

export interface SocketLimits {
  /** Decoded stdout record limit (the driver's per-line allowance). */
  maxRecordBytes: number
  maxStreamBytes: number
  maxRunBytes: number
  maxStderrKeptBytes: number
  /** Pause reading the socket while this many record bytes wait for the handler; resume at half. */
  pauseBytes: number
  /** Installation-wide cap on buffered, unprocessed record bytes across runs. */
  memoryBudgetBytes: number
  helloTimeoutMs: number
  maxUnauthenticated: number
}

export const DEFAULT_LIMITS: SocketLimits = {
  maxRecordBytes: 1024 * 1024,
  maxStreamBytes: 64 * 1024 * 1024,
  maxRunBytes: 128 * 1024 * 1024,
  maxStderrKeptBytes: 256 * 1024,
  pauseBytes: 1024 * 1024,
  memoryBudgetBytes: 64 * 1024 * 1024,
  helloTimeoutMs: 5000,
  maxUnauthenticated: 16,
}

export class SocketStartError extends Error {
  constructor(
    readonly code:
      | 'path-too-long'
      | 'bad-directory'
      | 'foreign-listener'
      | 'stale-needs-lock'
      | 'not-a-socket'
      | 'closed',
    message: string,
  ) {
    super(message)
  }
}

/** Bookkeeping cost charged per queued record on top of its text (array slot, string header). */
export const QUEUE_ENTRY_OVERHEAD_BYTES = 64

export interface Budget {
  used: number
  limit: number
}

/** What an active run may keep in memory beyond queued records (retained text, remembered call ids): reserved up front. */
export const RETAINED_RUN_BYTES = 512 * 1024

export interface CodingSocketOptions {
  /** `$XDG_RUNTIME_DIR` (or a test directory). */
  runtimeDir: string
  installationId: string
  limits?: Partial<SocketLimits>
  /** Why Score holds all agent work, or null (decisions 71 and 72). While held, Score sends no Stop frame of its own. */
  frozen?: () => string | null
}
