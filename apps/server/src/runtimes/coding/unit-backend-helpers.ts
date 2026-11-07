import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { fenceItems, isFenced } from '../../domain/orchestration/fence.ts'
import type { RunSession } from './coding-socket.ts'
import type { StopReason } from './process.ts'
import { parseReceipt } from './supervisor.mjs'

/** Policy, not protocol: how many units one installation may start per minute (unique names bypass systemd's own counters, §6b). */
export const LAUNCHES_PER_MINUTE = 30
/** A file the installation keeps (beside its journal, outside the home) once the unit check has passed (decision 69). */
export const UNIT_CAPABLE_FILE = 'unit-capable.json'
export const MARKER_PAUSE =
  'Coding runs are paused: Score couldn’t save that this computer runs supervised services, and it won’t start a run until it has. Check the disk and choose Check again.'
/** Written before `requested`: where the launch belongs, so a restored database that lost its rows can still route it. */
export const ROUTING_FILE = 'routing.json'
/** The supervisor's first stop cause, written before it acts on it (review 2026-10-12 #17). */
export const STOP_RECEIPT = 'stop-cause.json'

/**
 * Coding admission barrier from the fence (review 2026-10-12 #2): an unresolved restore, journal or installation
 * uncertainty, or a coding item, stops every coding launch, whichever engine launches and also inside release. Items
 * about orchestration attempts alone don't concern coding. This is the production callback; tests call it as it is.
 */
export function fenceBarrier(sqlite: DatabaseSync): string | null {
  if (!isFenced(sqlite)) return null
  const blocking = fenceItems(sqlite).some(
    (item) => item.kind === 'restore' || item.kind === 'journal' || item.ref.startsWith('coding'),
  )
  return blocking
    ? 'Score is waiting for you to review the execution journal before it starts coding runs.'
    : null
}
/**
 * Whether the environment forces the process-group engine. Only the test harness may (decision 70): in production a
 * host that ever ran supervised services never silently loses them, whatever the environment says.
 */
export function fallbackForced(env: NodeJS.ProcessEnv): boolean {
  return env.SCORE_CODING_BACKEND === 'process-group' && env.NODE_ENV === 'test'
}

export const STOP_CAUSE: Record<StopReason, string> = {
  user: 'user',
  timeout: 'deadline',
  output_limit: 'output-cap',
  shutdown: 'score-shutdown',
}
export function reasonOfCause(cause: string | null): StopReason | null {
  switch (cause) {
    case 'user':
    case 'cancel':
    case 'stop':
      return 'user'
    case 'deadline':
      return 'timeout'
    case 'output-cap':
    case 'run-cap':
      return 'output_limit'
    case 'score-shutdown':
    case 'unit-stop':
      return 'shutdown'
    default:
      return null
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export type Extra = Partial<
  Record<
    'manager' | 'stop_cause' | 'eligibility' | 'held' | 'deadline_at' | 'receipt_dir' | 'spec_dir',
    string | number | null
  >
>
export const EXTRA_COLUMNS = new Set([
  'manager',
  'stop_cause',
  'eligibility',
  'held',
  'deadline_at',
  'receipt_dir',
  'spec_dir',
])

export interface Row {
  launch_id: string
  run_id: string
  agent_id: string | null
  unit: string | null
  invocation_id: string | null
  cgroup: string | null
  manager: string | null
  receipt_dir: string | null
  phase: string
  revoked: number
  may_have_executed: number
  held: number
}

export const RoutingFile = z.object({
  launch: z.string().min(1),
  generation: z.number().int(),
  agentId: z.string().min(1),
  runtime: z.string().min(1),
  runId: z.string().min(1),
  turnId: z.string().min(1),
})

export const IDENTITY_FILE = 'identity.json'
export const IdentityFile = z.object({
  launch: z.string().min(1),
  generation: z.number().int(),
  at: z.number(),
  unit: z.string().min(1),
  invocationId: z.string().min(1),
  cgroup: z.string().min(1),
  boot: z.string().nullable(),
  manager: z.object({ pid: z.number().int(), start: z.string() }).nullable(),
  supervisor: z.object({ pid: z.number().int().positive(), start: z.string().regex(/^\d+$/) }),
})

/** Everything Score recorded about one launch, merged from the journal, the identity file and the database row. */
export interface RecordedLaunch {
  launchId: string
  unit: string | null
  invocationId: string | null
  cgroup: string | null
  boot: string | null
  /** `<pid>:<start>` of the user manager that verified the launch. */
  manager: string | null
  supervisor: { pid: number; start: string } | null
  /** Any source knows the launch. */
  known: boolean
  /** Names of the fields two sources disagree on, or null. */
  disagreement: string | null
  receiptDir: string
}

export interface StopTarget {
  recordStop(launchId: string, reason: StopReason): void
  sendStop(launchId: string, session: RunSession | null, reason: StopReason): void
}

export class Control {
  stopReason: StopReason | null = null
  private session: RunSession | null = null
  private wake: () => void = () => undefined
  readonly stopped: Promise<void> = new Promise<void>((resolve) => {
    this.wake = resolve
  })

  constructor(private readonly launchId: string) {}

  attach(session: RunSession): void {
    this.session = session
  }

  requestStop(reason: StopReason, backend: StopTarget): void {
    if (this.stopReason !== null) return
    this.stopReason = reason
    // Durable first, even before a session exists: the launch row may already be there.
    backend.recordStop(this.launchId, reason)
    this.wake()
    if (this.session) backend.sendStop(this.launchId, this.session, reason)
  }
}

/**
 * The CLI's stderr as it may be kept (review 2026-10-12 #4). Redaction needs the label in front of a value, so the
 * text is kept from its start (never a tail cut through a value) up to a raw limit, and it is redacted as a whole
 * whenever it is read. Past the limit the rest is dropped, not kept in a form redaction can't recognise.
 */

export const UNIT_NOTE = 'Runs as a supervised system service.'
export const FALLBACK_NOTE =
  'Runs without a supervisor: tools a coding CLI started may keep running until Score restarts and stops them.'

/** One definition of a valid receipt, shared with the writer (supervisor.mjs `parseReceipt`, FX1). */
export function validReceipt(
  text: string,
  kind: 'released' | 'ended' | 'acked',
  launchId: string,
  generation: number | undefined,
): boolean {
  if (generation === undefined) return false
  return parseReceipt(text, kind, { launch: launchId, generation }).state === 'present'
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function procCgroup(pid: number): string | null {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('0::'))
    return line ? line.slice(3) : null
  } catch {
    return null
  }
}
