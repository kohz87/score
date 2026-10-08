import { z } from 'zod'
import { AgentDetailSchema, AgentIdSchema } from './types.ts'

// Contract §10 (Settings: rules and approvals) and §8 (agent permissions).
// Go ahead = Hermes `command_allowlist` pattern keys; Never = `approvals.deny` globs; Ask me = every other
// known dangerous-command category. `mode` is Hermes's `approvals.mode`.
export const ApprovalModeSchema = z.enum(['manual', 'smart', 'off'])
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>

export const RuleSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  pattern: z.string().nullable(),
  // Keys Hermes itself wrote that Score does not know: shown, never edited.
  readOnly: z.boolean().default(false),
})
export type Rule = z.infer<typeof RuleSchema>

export const RulesResponseSchema = z.object({
  mode: ApprovalModeSchema,
  goAhead: z.array(RuleSchema),
  askMe: z.array(RuleSchema),
  never: z.array(RuleSchema),
  drift: z.array(z.object({ agentId: AgentIdSchema, differs: z.boolean() })),
})
export type RulesResponse = z.infer<typeof RulesResponseSchema>

const NoNul = z.string().refine((value) => !value.includes('\0'))
// A deny glob is matched against the raw command text: one line, not a bare wildcard.
export const NeverGlobSchema = NoNul.refine((value) => !/[\r\n]/.test(value))
  .transform((value) => value.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1).max(200))
  .refine((value) => /[^*?\s[\]]/.test(value), 'A rule needs some literal text')
export const PutRulesRequestSchema = z
  .object({
    mode: ApprovalModeSchema,
    goAhead: z.array(z.string().min(1).max(200)).max(200),
    never: z.array(NeverGlobSchema).max(100),
  })
  .strict()
export type PutRulesRequest = z.infer<typeof PutRulesRequestSchema>

export const RulesWriteResponseSchema = RulesResponseSchema.extend({
  // Profiles Hermes did not accept the baseline for (they show as drift).
  failed: z.array(AgentIdSchema),
})
export const RulesPreviewResponseSchema = z.object({ preview: z.string() })

export const PatchPermissionRequestSchema = z
  .object({ level: z.enum(['allowed', 'asks', 'never']) })
  .strict()

// DELETE /api/agents/:agentId/permissions/:permId: the agent's permissions after it went back to the team rule.
export const AgentPermissionsResponseSchema = z.object({
  items: AgentDetailSchema.shape.permissions,
})
export type AgentPermissionsResponse = z.infer<typeof AgentPermissionsResponseSchema>
