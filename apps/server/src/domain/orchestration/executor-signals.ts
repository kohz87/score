import { ORCH_LIMITS, type OrchReceipt } from '@score/contract'
import { valueHasCapability } from './capability.ts'
import { runCommand, type ToolName, parseToolArgs } from './commands.ts'
import { touch } from './ctx.ts'
import { getCodingAgent } from '../../runtimes/coding/store.ts'
import { bumpAdmission } from './ops.ts'
import { isTerminalStatus, listOrchs } from './store.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'

type ToolResult =
  { kind: 'receipt'; receipt: OrchReceipt } | { kind: 'unauthorized'; message: string }

export const signalMethods = {
  /**
   * An agent became ready again (a version check or gateway reachability recovered): attempts waiting out a refusal
   * backoff are tried at once, and every run with waiting work is re-evaluated (v8.2 item 1).
   */
  async agentReady(this: OrchestratorRuntime, agentId: string): Promise<void> {
    await this.mutate((ctx) => {
      ctx.sqlite
        .prepare(
          "UPDATE orc_attempts SET next_try_at = NULL, refused_streak = 0 WHERE agent_id = ? AND state = 'created' AND needs_person = 0",
        )
        .run(agentId)
      bumpAdmission(ctx.sqlite)
      for (const o of listOrchs(ctx.sqlite)) if (!isTerminalStatus(o.status)) touch(ctx, o.id)
    })
    this.kick()
  },

  /** Raised by routes that change a hold the executor does not see itself (team / agent Resume). */
  async admissionChanged(this: OrchestratorRuntime): Promise<void> {
    await this.mutate((ctx) => {
      bumpAdmission(ctx.sqlite)
      for (const o of listOrchs(ctx.sqlite)) if (!isTerminalStatus(o.status)) touch(ctx, o.id)
    })
    this.kick()
  },

  // ------------------------------------------------------------------------------------------------------ MCP tools

  /** One `orch.*` call from the MCP server. `agentId` is the token's agent. */
  async handleTool(
    this: OrchestratorRuntime,
    agentId: string,
    tool: ToolName,
    raw: unknown,
  ): Promise<ToolResult> {
    const parsed = parseToolArgs(tool, raw)
    if (!parsed.ok)
      return {
        kind: 'receipt',
        receipt: { status: 'refused', code: 'bad_arguments', message: parsed.message, tool },
      }
    // Nothing the lead sends may carry a capability (ids, agents, text): it would be stored or reflected in a receipt.
    if (valueHasCapability(parsed.args, ['capability']))
      return {
        kind: 'receipt',
        receipt: {
          status: 'refused',
          code: 'capability_in_text',
          message: 'A field contains something shaped like a capability; remove it',
          tool,
        },
      }
    if (tool === 'orch.assign' && typeof parsed.args.agent === 'string') {
      const isAntigravity = this.db.read(
        (sqlite) => getCodingAgent(sqlite, parsed.args.agent as string)?.runtime === 'antigravity',
      )
      if (isAntigravity) await this.options.codingFacts?.quota?.refresh().catch(() => undefined)
    }
    const outcome = await this.mutate((ctx) =>
      runCommand(ctx, agentId, tool, parsed.args, {
        commandsPerAttempt: ORCH_LIMITS.commandsPerLeadAttempt,
      }),
    )
    if (outcome.kind === 'unauthorized') return outcome
    if (outcome.changed) this.kick()
    return outcome
  },
}

export type SignalMethods = typeof signalMethods

export type SignalPublicMethods = Pick<
  SignalMethods,
  'agentReady' | 'admissionChanged' | 'handleTool'
>
