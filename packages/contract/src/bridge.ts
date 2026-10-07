import { z } from 'zod'
import { ApprovalChoiceSchema } from './types.ts'

export const BridgeIdentifierSchema = z.string().regex(/^[\x21-\x7e]{1,256}$/)

export const BridgeHelloRequestSchema = z.object({
  profile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
  pid: z.int().positive(),
  incarnation: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$/),
  kanbanTaskId: BridgeIdentifierSchema.nullable(),
  isolation: z.enum(['in_process', 'host', 'unknown']),
  pluginVersion: z.string(),
  hermes: z.object({ version: z.string(), codeSha: z.string() }),
  privateApis: z.record(z.string().regex(/^[A-Za-z0-9_.]{1,128}$/), z.boolean()),
})
export type BridgeHelloRequest = z.infer<typeof BridgeHelloRequestSchema>

export const BridgeHelloResponseSchema = z.object({
  producerToken: z.string().min(1),
  expiresAt: z.iso.datetime(),
  enabled: z.object({
    gatewayApprovals: z.boolean(),
    kanbanGrants: z.boolean(),
    watch: z.boolean(),
  }),
})
export type BridgeHelloResponse = z.infer<typeof BridgeHelloResponseSchema>

export const BridgeEventSchema = z.object({
  counter: z.int().positive(),
  hook: z.string(),
  at: z.iso.datetime(),
  sessionKey: BridgeIdentifierSchema.nullable(),
  sessionId: BridgeIdentifierSchema.nullable(),
  toolCallId: BridgeIdentifierSchema.nullable(),
  payload: z.record(z.string(), z.unknown()),
})
export type BridgeEvent = z.infer<typeof BridgeEventSchema>

export const BridgeEventsRequestSchema = z.object({ events: z.array(BridgeEventSchema) })
export type BridgeEventsRequest = z.infer<typeof BridgeEventsRequestSchema>

export const BridgeEventsResponseSchema = z.object({ ackedThrough: z.int().nonnegative() })
export type BridgeEventsResponse = z.infer<typeof BridgeEventsResponseSchema>

export const BridgeDecisionsRequestSchema = z.object({
  wait: z.coerce.number().int().min(0).max(30).default(25),
})
export type BridgeDecisionsRequest = z.infer<typeof BridgeDecisionsRequestSchema>

export const BridgeDecisionSchema = z.object({
  deliveryId: z.string().min(1),
  leaseUntil: z.iso.datetime(),
  sessionKey: z.string().min(1),
  requestId: z.string().min(1),
  choice: ApprovalChoiceSchema,
  reason: z.string().nullable(),
})
export type BridgeDecision = z.infer<typeof BridgeDecisionSchema>

export const BridgeDecisionsResponseSchema = z.object({ items: z.array(BridgeDecisionSchema) })
export type BridgeDecisionsResponse = z.infer<typeof BridgeDecisionsResponseSchema>

export const BridgeDecisionAckRequestSchema = z.object({
  outcome: z.enum(['applied', 'not_pending', 'failed']),
  resolved: z.int().nonnegative(),
  error: z.string().optional(),
})
export type BridgeDecisionAckRequest = z.infer<typeof BridgeDecisionAckRequestSchema>

export const BridgeGrantRedeemRequestSchema = z.object({
  taskId: z.string().min(1),
  taskRunId: z.int().positive(),
  commandDigest: z.string().regex(/^[0-9a-f]{64}$/),
  toolCallId: z.string().min(1),
})
export type BridgeGrantRedeemRequest = z.infer<typeof BridgeGrantRedeemRequestSchema>

export const BridgeGrantRedeemResponseSchema = z.object({
  grantId: z.string().min(1),
  patternKey: z.string(),
})
export type BridgeGrantRedeemResponse = z.infer<typeof BridgeGrantRedeemResponseSchema>

export const BridgeGrantConsumeRequestSchema = z.object({
  toolCallId: z.string().min(1),
  outcome: z.enum(['executed', 'blocked', 'revoked']),
})
export type BridgeGrantConsumeRequest = z.infer<typeof BridgeGrantConsumeRequestSchema>
