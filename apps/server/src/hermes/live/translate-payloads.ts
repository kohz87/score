import { ApprovalChoiceSchema } from '@score/contract'
import { z } from 'zod'
import { UsageSchema } from './gateway.ts'

export const EnvelopeSchema = z.object({
  event: z.string().min(1),
  run_id: z.string().min(1),
  seq: z.int().nonnegative(),
  timestamp: z.number().finite().nonnegative(),
})
// Hermes sends `preview: null` for MCP tools (seen live with `mcp__score__orch_plan`); a parse error here would stall the
// whole run's event feed on that one event, so an absent preview is just empty text.
export const ToolStartedSchema = z.object({
  tool: z.string().min(1),
  preview: z
    .string()
    .nullish()
    .transform((preview) => preview ?? ''),
})
export const ToolCompletedSchema = ToolStartedSchema.extend({
  duration: z.number().finite().nonnegative(),
  error: z.boolean(),
})
export const ReasoningSchema = z.object({ text: z.string() })
export const DeltaSchema = z.object({ delta: z.string() })
export const InterimSchema = z.object({
  text: z.string(),
  already_streamed: z.boolean().optional(),
})
export const TerminalSchema = z.object({
  output: z.string().nullish(),
  error: z.string().nullish(),
  usage: UsageSchema.nullish(),
  // 0.22.5: why a turn that did not complete stopped (e.g. `max_iterations_reached(90/90)`).
  turn_exit_reason: z.string().max(200).nullish(),
})
// 0.22.5 clarify (decision 128): an agent's question to the person, answered at /v1/runs/{id}/clarify.
export const ClarifySchema = z.object({
  prompt_id: z.string().min(1),
  execution_generation: z.int().nullish(),
  question: z.string(),
  choices: z.array(z.string()).nullish(),
  multi_select: z.boolean().nullish(),
  timeout_s: z.number().finite().positive().max(86400).nullish(),
})
export const SettledSchema = z.object({ prompt_id: z.string().min(1) })
// Known 0.22.5 events Score has no use for: admission queueing, steer acknowledgements, and tool progress (the
// started/completed pair already carries the tool).
export const PASSIVE_EVENTS = new Set(['run.queued', 'run.steered', 'tool.progress'])
// Hermes 0.22.5 under its session authority (gateway/session_pending_controls.py) names the prompt `prompt_id` and
// adds `execution_generation`, `kind` and `timeout_s`; older builds and the non-authority path send `request_id`.
export const ApprovalSchema = z
  .object({
    command: z.string(),
    description: z.string(),
    request_id: z.string().min(1).optional(),
    prompt_id: z.string().min(1).optional(),
    timeout_s: z.number().finite().positive().max(86400).optional(),
    choices: z.array(ApprovalChoiceSchema),
    pattern_keys: z.array(z.string()).optional(),
    pattern_key: z.string().optional(),
    expires_at: z
      .union([
        z.iso.datetime(),
        z
          .number()
          .finite()
          .nonnegative()
          .max(253402300799)
          .transform((value) => new Date(value * 1000).toISOString()),
      ])
      .optional(),
  })
  .passthrough()
  .refine((value) => Boolean(value.request_id ?? value.prompt_id), {
    message: 'An approval request needs request_id or prompt_id',
  })
// Other API clients may answer without a request_id (resolve-first or resolve-all); that is evidence we can't bind.
export const ResponseSchema = z.object({
  request_id: z.string().min(1).optional(),
  choice: ApprovalChoiceSchema,
  resolved: z.int().nonnegative().optional(),
})
