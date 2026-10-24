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
