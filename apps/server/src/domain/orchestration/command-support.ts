import type { OrchReceipt } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { readWorkerPolicy } from './coding-policy.ts'
import type { Ctx } from './ctx.ts'
import { storageRoom } from './ops.ts'
import type { AttemptRow, OrchRow } from './store.ts'

export const ok = (result: Record<string, unknown>): OrchReceipt => ({ status: 'ok', result })
export const refuse = (code: string, message: string): OrchReceipt => ({
  status: 'refused',
  code,
  message,
})

/** `{ policyId }` for a coding worker with a stored policy, nothing for a Hermes agent. */
export function policyField(
  sqlite: DatabaseSync,
  orchId: string,
  agentId: string,
): { policyId?: string } {
  const stored = readWorkerPolicy(sqlite, orchId, agentId)
  return stored ? { policyId: stored.policyId } : {}
}

export type Args = Record<string, unknown> & { capability: string; commandId: string }
export type Handler = (ctx: Ctx, o: OrchRow, attempt: AttemptRow, args: Args) => OrchReceipt

export const quotaRefusal = (o: OrchRow, bytes: number): OrchReceipt | undefined =>
  bytes > storageRoom(o)
    ? refuse('quota', "This run's storage allowance is used up; finish or stop the run")
    : undefined
