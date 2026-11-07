import { z } from 'zod'

export const GateSignalSchema = z.object({
  kind: z.enum(['pre', 'post', 'closed']),
  surface: z.string().default('unknown'),
  command: z.string().default(''),
  description: z.string().default(''),
  pattern_keys: z.array(z.string()).default([]),
  pattern_key: z.string().nullish(),
  allow_session: z.boolean().optional(),
  allow_permanent: z.boolean().optional(),
  coalesced: z.boolean().default(false),
  choice: z.string().optional(),
  commandDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullish(),
  command_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullish(),
  toolCallId: z.string().nullish(),
  turnId: z.string().nullish(),
  sessionId: z.string().nullish(),
  supersedesGateId: z.string().nullish(),
  expiresAt: z.iso.datetime().nullish(),
})
export const SignalRowSchema = z.object({
  id: z.int(),
  producer_id: z.string(),
  profile: z.string(),
  session_key: z.string().nullable(),
  request_id: z.string().nullable(),
  producer_incarnation: z.string().nullable(),
  counter: z.int().nullable(),
  gate_id: z.string().nullable(),
  linked_gate_id: z.string().nullable(),
  transport_request_id: z.string().nullable(),
  matched_approval_id: z.string().nullable(),
  payload: z.string().transform((v) => GateSignalSchema.parse(JSON.parse(v))),
  at: z.iso.datetime(),
})
export type Signal = z.infer<typeof SignalRowSchema>
export const IdSchema = z.object({ id: z.string() })
