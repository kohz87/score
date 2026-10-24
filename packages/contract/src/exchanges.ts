import { z } from 'zod'
import { CommandIdSchema } from './orchestration.ts'
import { AgentIdSchema } from './types.ts'

// Exchanges and agent actions (PLAN 11.1b; design docs/briefs/11.0-bold.md §3.4, §4). An agent in a room with
// `routing = exchanges` hands work on, asks, reviews, approves or sends back with one action per turn. Hermes agents
// call the bridge plugin tools `score_*`; coding agents end their reply with one fenced `score-action` block. Both
// reach the same server applier.

export const EXCHANGE_LIMITS = {
  noteBytes: 4000,
  replyBytes: 8000,
  /** Default turns per exchange and per job (brief §4.5; decision 113). */
  exchangeBudget: 8,
  jobTurnLimit: 40,
  /** Nested `ask` depth below a top-level exchange. */
  askDepth: 2,
  /** "Give N more turns" (11.1c). */
  moreTurnsMax: 20,
  /** What a running turn is reserved at against a job's spend cap (as the orchestrator's step estimate). */
  turnEstimateUsd: 0.5,
} as const

/** `xtc_` + 43 base64url characters: the per-turn exchange capability (brief §4.2), distinct from `orc_` and `scm_`. */
export const XTC_CAPABILITY_PATTERN = /^xtc_[A-Za-z0-9_-]{43}$/
/** Where a stored turn input carries the capability; replaced only in the payload sent to Hermes. */
export const XTC_CAPABILITY_PLACEHOLDER = '{{SCORE_EXCHANGE_CAPABILITY}}'

export const ExchangeActionKindSchema = z.enum([
  'handoff',
  'ask',
  'review',
  'approve',
  'send_back',
  'reply',
  'extend',
  'stop_exchange',
])
export type ExchangeActionKind = z.infer<typeof ExchangeActionKindSchema>

/** Routing actions: at most one per turn (a second needs `replaces`). `reply` only marks the answer to an `ask`. */
export const ROUTING_ACTIONS: readonly ExchangeActionKind[] = [
  'handoff',
  'ask',
  'review',
  'approve',
  'send_back',
]

const utf8Bytes = (value: string) => new TextEncoder().encode(value).length
const text = (max: number) =>
  z
    .string()
    .min(1)
    .refine((v) => utf8Bytes(v) <= max, `limited to ${max} bytes`)
    .refine((v) => !v.includes('\0'), 'No NUL')

const replaces = { replaces: CommandIdSchema.optional() }

/** The action itself, as both channels carry it (the bridge adds capability and commandId around it). */
export const ExchangeActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('handoff'),
      to: AgentIdSchema,
      note: text(EXCHANGE_LIMITS.noteBytes),
      ...replaces,
    })
    .strict(),
  z
    .object({
      action: z.literal('ask'),
      to: AgentIdSchema,
      question: text(EXCHANGE_LIMITS.noteBytes),
      ...replaces,
    })
    .strict(),
  z
    .object({
      action: z.literal('review'),
      to: AgentIdSchema,
      note: text(EXCHANGE_LIMITS.noteBytes),
      ...replaces,
    })
    .strict(),
  z
    .object({ action: z.literal('approve'), note: text(EXCHANGE_LIMITS.noteBytes), ...replaces })
    .strict(),
  z
    .object({
      action: z.literal('send_back'),
      note: text(EXCHANGE_LIMITS.noteBytes),
      ...replaces,
    })
    .strict(),
  z.object({ action: z.literal('reply'), text: text(EXCHANGE_LIMITS.replyBytes) }).strict(),
  // Only in the room lead's turn deciding a budget pause ("Let lead decide", 11.1c): one of the two, once.
  z
    .object({
      action: z.literal('extend'),
      turns: z.int().min(1).max(100),
      note: text(EXCHANGE_LIMITS.noteBytes),
    })
    .strict(),
  z.object({ action: z.literal('stop_exchange'), note: text(EXCHANGE_LIMITS.noteBytes) }).strict(),
])
export type ExchangeAction = z.infer<typeof ExchangeActionSchema>

/** `POST /bridge/v1/exchanges/action` body (contract §11). */
export const BridgeExchangeActionRequestSchema = z
  .object({
    capability: z.string().regex(XTC_CAPABILITY_PATTERN),
    commandId: CommandIdSchema,
    action: ExchangeActionSchema,
  })
  .strict()
export type BridgeExchangeActionRequest = z.infer<typeof BridgeExchangeActionRequestSchema>

/**
 * What the agent gets back. `staged`: accepted, applied when the turn completes (`message` says what will happen);
 * `refused`: nothing staged (`code` says why). A repeated commandId returns the stored receipt unchanged.
 */
export const ExchangeReceiptSchema = z.object({
  status: z.enum(['staged', 'refused']),
  commandId: CommandIdSchema,
  action: ExchangeActionKindSchema,
  /** `capability_invalid`, `capability_in_text`, `not_member`, `self`, `action_limit`, `not_allowed`, `invalid`, … */
  code: z.string().optional(),
  message: z.string(),
})
export type ExchangeReceipt = z.infer<typeof ExchangeReceiptSchema>

/** A job: a thread inside a room with its own agent sessions (brief §3.2). `job.upserted` carries the whole row. */
export const JobSchema = z.object({
  id: z.string().min(1),
  roomId: z.string().min(1),
  title: z.string(),
  state: z.enum(['open', 'working', 'waiting_on_you', 'done', 'closed']),
  /** Who has the work now. */
  holderAgentId: AgentIdSchema.nullable(),
  /** The room's own thread (every room has one; older rooms have only it). */
  isDefault: z.boolean(),
  exchangeBudget: z.int().positive(),
  jobTurnLimit: z.int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type Job = z.infer<typeof JobSchema>

export const ExchangeKindSchema = z.enum(['handoff', 'ask', 'review'])
export const ExchangePauseReasonSchema = z.enum([
  'exchange_budget',
  'job_limit',
  'spend_cap',
  'cost_unknown',
  'turn_failed',
  'unreachable',
  'asker_gone',
  'no_decision',
  'author_stalled',
])
export type ExchangePauseReason = z.infer<typeof ExchangePauseReasonSchema>
export const ExchangeOptionSchema = z.enum([
  'more_turns',
  'more_spend',
  'continue',
  'lead_decides',
  'step_in',
  'stop',
  'retry',
  'reassign',
  'answer_to_lead',
  'ask_again',
  'send_back',
  'close',
])
export type ExchangeOption = z.infer<typeof ExchangeOptionSchema>
export const ExchangeStateSchema = z.enum([
  'live',
  'waiting_on_agent',
  'waiting_on_you',
  'paused_budget',
  'done',
  'stopped',
])
/** Two agents working on one step of a job (brief §3.4). `exchange.upserted` carries the whole row. */
export const ExchangeSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  roomId: z.string().min(1),
  kind: ExchangeKindSchema,
  /** The exchange an `ask` was opened from (null at the top). */
  parentId: z.string().min(1).nullable(),
  /** Who opened it (the author of the work under review, the asker, the one handing off). */
  from: AgentIdSchema,
  /** Who it was opened to (the reviewer, the one asked, the one handed to). */
  to: AgentIdSchema,
  state: ExchangeStateSchema,
  /** Review rounds: each `send_back` starts the next one. */
  round: z.int().positive(),
  turnsUsed: z.int().nonnegative(),
  budget: z.int().positive(),
  /** `approved` (review), `answered` (ask), `handed_off`, `no_decision` (a reviewer ended without a verdict). */
  outcome: z.enum(['approved', 'answered', 'handed_off', 'no_decision']).nullable(),
  /** Plain words for a stopped or stuck exchange ("the turn failed", "stopped by you"). */
  endedReason: z.string().nullable(),
  /** Why it waits on the person and what they can do (11.1c, brief §4.5–§4.6); null while it runs or is done. */
  pause: z
    .object({ reason: ExchangePauseReasonSchema, options: z.array(ExchangeOptionSchema) })
    .nullable(),
  /** Its next turn waits on that agent's turn in another job of the room (§4.6): shown, nothing to decide. */
  queuedBehind: z.object({ agentId: AgentIdSchema, since: z.iso.datetime() }).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type Exchange = z.infer<typeof ExchangeSchema>

/** `POST /api/exchanges/:id/decision` (11.1c). The option must be one the exchange's `pause.options` offers. */
export const ExchangeDecisionRequestSchema = z.discriminatedUnion('option', [
  z
    .object({
      option: z.literal('more_turns'),
      turns: z.int().min(1).max(EXCHANGE_LIMITS.moreTurnsMax),
    })
    .strict(),
  z.object({ option: z.literal('more_spend'), usd: z.number().positive().max(1000) }).strict(),
  z.object({ option: z.literal('continue') }).strict(),
  z.object({ option: z.literal('lead_decides') }).strict(),
  z.object({ option: z.literal('step_in'), text: text(EXCHANGE_LIMITS.noteBytes) }).strict(),
  z.object({ option: z.literal('stop') }).strict(),
  z.object({ option: z.literal('retry') }).strict(),
  z.object({ option: z.literal('reassign'), to: AgentIdSchema }).strict(),
  z.object({ option: z.literal('answer_to_lead') }).strict(),
  z.object({ option: z.literal('ask_again') }).strict(),
  z.object({ option: z.literal('send_back'), note: text(EXCHANGE_LIMITS.noteBytes) }).strict(),
  z.object({ option: z.literal('close') }).strict(),
])
export type ExchangeDecisionRequest = z.infer<typeof ExchangeDecisionRequestSchema>

export const JobsResponseSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  items: z.array(JobSchema),
})
export const JobCreateRequestSchema = z
  .object({ title: z.string().trim().min(1).max(200) })
  .strict()
export const ExchangesResponseSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  items: z.array(ExchangeSchema),
})
