import {
  OrchAskArgsSchema,
  OrchAssignArgsSchema,
  OrchCancelArgsSchema,
  OrchCheckArgsSchema,
  OrchVoteArgsSchema,
  OrchFinishArgsSchema,
  OrchNoteArgsSchema,
  OrchPlanArgsSchema,
  OrchReceiptArgsSchema,
  OrchRequestApprovalArgsSchema,
} from '@score/contract'
import { createHash } from 'node:crypto'
import type { z } from 'zod'

// The `orch.*` tools (design v1-v3). A call is a command: its identity, canonical payload hash, mutation, reservations
// and receipt commit in the caller's single transaction. Refusals are receipts too (the lead can look them up).

export const TOOLS = [
  'orch.plan',
  'orch.assign',
  'orch.cancel',
  'orch.ask',
  'orch.requestApproval',
  'orch.note',
  'orch.finish',
  'orch.receipt',
  'orch.check',
  'orch.vote',
] as const
export type ToolName = (typeof TOOLS)[number]

const SCHEMAS = {
  'orch.plan': OrchPlanArgsSchema,
  'orch.assign': OrchAssignArgsSchema,
  'orch.cancel': OrchCancelArgsSchema,
  'orch.ask': OrchAskArgsSchema,
  'orch.requestApproval': OrchRequestApprovalArgsSchema,
  'orch.note': OrchNoteArgsSchema,
  'orch.finish': OrchFinishArgsSchema,
  'orch.receipt': OrchReceiptArgsSchema,
  'orch.check': OrchCheckArgsSchema,
  'orch.vote': OrchVoteArgsSchema,
} as const

export function parseToolArgs(
  tool: ToolName,
  raw: unknown,
):
  | { ok: true; args: Record<string, unknown> & { capability: string; commandId: string } }
  | { ok: false; message: string } {
  const parsed = (SCHEMAS[tool] as z.ZodType).safeParse(raw)
  if (!parsed.success)
    return {
      ok: false,
      message: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
        .join('; '),
    }
  return {
    ok: true,
    args: parsed.data as Record<string, unknown> & { capability: string; commandId: string },
  }
}

/** Canonical payload: keys sorted, capability and commandId excluded (they identify the call, not its content). */
export function payloadHash(tool: string, args: Record<string, unknown>): string {
  const content = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== 'capability' && key !== 'commandId'),
  )
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, sorted(child)]),
          )
        : value
  return createHash('sha256')
    .update(JSON.stringify(sorted({ tool, ...content })))
    .digest('hex')
}
