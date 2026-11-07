import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { AgentCreateInputSchema, type ProfileStepName } from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import { lifecycleOf } from './agent-lifecycle.ts'

export const OperationRow = z.object({
  operation: z.string(),
  request: z.string(),
  target_identity: z.string().nullable(),
})
export const StoredRequest = z.object({
  input: AgentCreateInputSchema.nullable(),
  /** Import only: the uploaded archive this operation installs from. */
  importUpload: z.uuid().nullable().optional(),
  baseline: z.object({
    mode: z.enum(['manual', 'smart', 'off']),
    goAhead: z.array(z.string()),
    never: z.array(z.string()),
  }),
})
export const emptyInherited = {
  memories: [],
  skills: [],
  plugins: [],
  approvalSettings: [],
  credentialsPresent: [],
}
export const createSteps: ProfileStepName[] = [
  'create_profile',
  'preserve_key',
  'configure_key',
  'model',
  'permissions',
  'install_bridge',
  'enable_bridge',
  'verify_ready',
]
export const importSteps: ProfileStepName[] = [
  'import_profile',
  'describe_profile',
  'preserve_key',
  'configure_key',
  'permissions',
  'install_bridge',
  'enable_bridge',
  'verify_ready',
]
export const deleteSteps: ProfileStepName[] = [
  'export',
  'delete_profile',
  'purge_identity',
  'retire',
]

/**
 * 3.2.2: the create (or import) that stopped and holds an agent in needs_attention, when removing the agent should
 * abandon it. Null while the operation still runs or when something else holds the agent.
 */
export function stoppedSetup(sqlite: DatabaseSync, name: string): { id: string } | null {
  const lifecycle = lifecycleOf(sqlite, name)
  if (lifecycle?.state !== 'needs_attention' || !lifecycle.operation_id) return null
  const row = sqlite
    .prepare(
      "SELECT id, operation FROM profile_operations WHERE id = ? AND state = 'needs_attention'",
    )
    .get(lifecycle.operation_id) as { id: string; operation: string } | undefined
  if (!row) return null
  const stored = z
    .object({ kind: z.string(), confirmable: z.boolean().optional() })
    .safeParse(JSON.parse(row.operation)).data
  // A step Score lost track of (interrupted, outcome unknown: `confirmable`) is never abandoned — Hermes may still
  // finish it, so the person confirms what happened first; only a recorded failure is abandoned.
  if (!stored || stored.confirmable === true) return null
  return stored.kind === 'create' || stored.kind === 'import' ? { id: row.id } : null
}

/** A save refused because the operation was abandoned meanwhile (a removal closed it): its run stops quietly. */
export class AbandonedOperation extends HttpError {
  constructor() {
    super(409, 'conflict', 'This setup was abandoned when the agent was removed.')
  }
}
export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

// Steps whose repeat is harmless: reads, idempotent config writes, the export (a retry reuses its own file) and
// Score-side retirement.
export const RETRYABLE_STEPS: ReadonlySet<string> = new Set([
  'model',
  'describe_profile',
  'permissions',
  'enable_bridge',
  'verify_ready',
  'export',
  'purge_identity',
  'retire',
])

export type StoredRequestValue = z.infer<typeof StoredRequest>

export interface PendingWork {
  activeRuns: number
  queuedTurns: number
  pendingApprovals: number
  assignments: number
  disposition: string
}
