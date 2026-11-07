import type { OrchReceipt } from '@score/contract'
import { agentAdmits, lifecycleOf } from '../agent-lifecycle.ts'
import { hashCapability } from './capability.ts'
import { payloadHash, TOOLS, parseToolArgs, type ToolName } from './command-args.ts'
import { HANDLERS } from './command-handlers.ts'
import { refuse } from './command-support.ts'
import { touch, type Ctx } from './ctx.ts'
import { addStored, utf8Bytes } from './ops.ts'
import { readAttempt, readOrch } from './store.ts'

// The `orch.*` tools (design v1-v3). A call is a command: its identity, canonical payload hash, mutation, reservations
// and receipt commit in the caller's single transaction. Refusals are receipts too (the lead can look them up).

export { TOOLS, parseToolArgs }
export type { ToolName }
export { cancelStep } from './command-steps.ts'

type CommandOutcome =
  | { kind: 'receipt'; receipt: OrchReceipt; changed: boolean }
  | { kind: 'unauthorized'; message: string }

const incarnationOf = (ctx: Ctx, agentId: string): string =>
  lifecycleOf(ctx.sqlite, agentId)?.incarnation_id ?? 'untracked'

/**
 * One tool call, inside the caller's transaction. `agentId` is the MCP token's agent.
 */
export function runCommand(
  ctx: Ctx,
  agentId: string,
  tool: ToolName,
  args: Record<string, unknown> & { capability: string; commandId: string },
  limits: { commandsPerAttempt: number },
): CommandOutcome {
  const { sqlite, now } = ctx
  const capability = sqlite
    .prepare('SELECT * FROM orc_capabilities WHERE hash = ?')
    .get(hashCapability(args.capability)) as
    | {
        attempt_id: string
        agent_id: string
        agent_incarnation: string
        expired_at: string | null
      }
    | undefined
  if (!capability) return { kind: 'unauthorized', message: 'unknown capability' }
  // The MCP token must belong to the lead the capability was issued to, in the incarnation it was issued for.
  if (capability.agent_id !== agentId)
    return { kind: 'unauthorized', message: 'this capability belongs to another agent' }
  if (incarnationOf(ctx, agentId) !== capability.agent_incarnation || !agentAdmits(sqlite, agentId))
    return {
      kind: 'unauthorized',
      message: 'the lead agent changed since this capability was issued',
    }
  const attempt = readAttempt(sqlite, capability.attempt_id)
  if (!attempt) return { kind: 'unauthorized', message: 'unknown capability' }
  if (capability.expired_at !== null || attempt.retired)
    return { kind: 'unauthorized', message: 'this capability has expired (stale generation)' }
  if (attempt.state === 'send_started')
    // Admission of this lead attempt is not recorded yet: nothing is stored, the same commandId may be sent again.
    return {
      kind: 'receipt',
      changed: false,
      receipt: {
        status: 'retry',
        code: 'admission_pending',
        message: 'Score has not recorded this turn yet; send the same call again in a moment',
        commandId: args.commandId,
        tool,
      },
    }
  if (attempt.state !== 'running')
    return { kind: 'unauthorized', message: 'this capability has expired (the turn is over)' }
  const o = readOrch(sqlite, attempt.orchestration_id)
  if (!o) return { kind: 'unauthorized', message: 'unknown capability' }
  // The turn is over as soon as Hermes says its run ended, not only once the executor has reconciled it.
  const ended = attempt.run_id
    ? (sqlite.prepare('SELECT status FROM runs WHERE id = ?').get(attempt.run_id) as
        { status: string } | undefined)
    : undefined
  if (ended && ['completed', 'failed', 'cancelled', 'interrupted'].includes(ended.status)) {
    sqlite
      .prepare('UPDATE orc_capabilities SET expired_at = ? WHERE hash = ? AND expired_at IS NULL')
      .run(now, hashCapability(args.capability))
    return { kind: 'unauthorized', message: 'this capability has expired (the turn is over)' }
  }

  const stored = sqlite
    .prepare(
      'SELECT tool, payload_hash, receipt FROM orc_commands WHERE attempt_id = ? AND command_id = ?',
    )
    .get(attempt.id, args.commandId) as
    { tool: string; payload_hash: string; receipt: string } | undefined

  if (tool === 'orch.receipt') {
    const lookup = args.commandId
    const row = sqlite
      .prepare('SELECT receipt FROM orc_commands WHERE attempt_id = ? AND command_id = ?')
      .get(attempt.id, lookup) as { receipt: string } | undefined
    return {
      kind: 'receipt',
      changed: false,
      receipt: row
        ? (JSON.parse(row.receipt) as OrchReceipt)
        : {
            status: 'not_found',
            commandId: lookup,
            tool,
            message: 'No stored command with that id in this turn',
          },
    }
  }

  const hash = payloadHash(tool, args)
  if (stored) {
    if (stored.tool === tool && stored.payload_hash === hash)
      return { kind: 'receipt', changed: false, receipt: JSON.parse(stored.receipt) as OrchReceipt }
    return {
      kind: 'receipt',
      changed: false,
      receipt: {
        status: 'conflict',
        code: 'command_id_reused',
        commandId: args.commandId,
        tool,
        message: 'That commandId was already used for a different call',
      },
    }
  }
  if (attempt.commands >= limits.commandsPerAttempt)
    return {
      kind: 'receipt',
      changed: false,
      receipt: {
        status: 'refused',
        code: 'command_limit',
        commandId: args.commandId,
        tool,
        message: `At most ${limits.commandsPerAttempt} commands per lead turn`,
      },
    }

  let receipt: OrchReceipt
  if (o.finish_requested_at !== null)
    receipt = refuse('sealed', 'The run has a finish request; no further commands are accepted')
  else if (o.status !== 'running' && o.status !== 'paused')
    receipt = refuse('not_running', `The run is ${o.status}`)
  else receipt = HANDLERS[tool](ctx, o, attempt, args)

  const full: OrchReceipt = { ...receipt, commandId: args.commandId, tool }
  const text = JSON.stringify(full)
  sqlite
    .prepare(
      'INSERT INTO orc_commands (attempt_id, command_id, orchestration_id, tool, payload_hash, receipt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(attempt.id, args.commandId, o.id, tool, hash, text, now)
  sqlite.prepare('UPDATE orc_attempts SET commands = commands + 1 WHERE id = ?').run(attempt.id)
  addStored(sqlite, o.id, utf8Bytes(text))
  touch(ctx, o.id)
  return { kind: 'receipt', receipt: full, changed: true }
}
