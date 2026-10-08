import { z } from 'zod'
import { AgentStyleSchema } from './types.ts'

const Text = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((v) => !v.includes('\0'))
export const ProfileNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
export const AgentCreateInputSchema = z
  .object({
    id: ProfileNameSchema,
    name: Text.max(100),
    role: Text,
    style: AgentStyleSchema,
    model: Text.max(256),
    /** Provider id serving the model (GET /api/models); set together with it. */
    provider: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
      .optional(),
    cloneFrom: ProfileNameSchema.optional(),
  })
  .strict()
export const AgentPreviewRequestSchema = z.discriminatedUnion('kind', [
  AgentCreateInputSchema.extend({ kind: z.literal('create') }),
  z.object({ kind: z.literal('delete'), agentId: ProfileNameSchema }).strict(),
])
export const AgentCreateRequestSchema = AgentCreateInputSchema.extend({
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmInheritance: z.boolean().optional(),
}).strict()
export const OperationConfirmRequestSchema = z.object({ step: z.string().min(1).max(64) }).strict()
export const AgentPatchRequestSchema = z
  .object({ name: Text.max(100).optional(), role: Text.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0)
export const AgentDeleteRequestSchema = z
  .object({
    typedName: ProfileNameSchema,
    previewHash: AgentCreateRequestSchema.shape.previewHash,
  })
  .strict()
export const ProfileStepNameSchema = z.enum([
  'create_profile',
  'preserve_key',
  'configure_key',
  'model',
  'permissions',
  'install_bridge',
  'enable_bridge',
  'verify_ready',
  'export',
  'delete_profile',
  'purge_identity',
  'retire',
])
export const AgentOperationSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['create', 'delete']),
  targetName: ProfileNameSchema,
  incarnationId: z.uuid(),
  requestHash: z.string(),
  state: z.enum(['running', 'needs_attention', 'completed']),
  steps: z.array(
    z.object({ name: ProfileStepNameSchema, state: z.enum(['pending', 'running', 'completed']) }),
  ),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  nextStep: ProfileStepNameSchema.nullable(),
  error: z.string().nullable(),
  exportPath: z.string().nullable(),
  /** The step failed with a recorded, repeatable error (not an unknown interruption): POST …/retry may run it again. */
  retryable: z.boolean().optional(),
  /** Score lost track of the step (restart mid-step): the person may check it locally and confirm it finished. */
  confirmable: z.boolean().optional(),
})
export const AgentPreviewSchema = z.object({
  kind: z.enum(['create', 'delete']),
  targetName: ProfileNameSchema,
  hash: z.string(),
  inherited: z.object({
    memories: z.array(z.string()),
    skills: z.array(z.string()),
    plugins: z.array(z.string()),
    approvalSettings: z.array(z.string()),
    credentialsPresent: z.array(z.string()),
  }),
  effects: z.array(z.string()),
  blockers: z.array(z.string()),
  pendingWork: z.object({
    activeRuns: z.int().nonnegative(),
    queuedTurns: z.int().nonnegative(),
    pendingApprovals: z.int().nonnegative(),
    assignments: z.int().nonnegative(),
    disposition: z.string(),
  }),
  exportPath: z.string().nullable(),
})
export type AgentCreateInput = z.infer<typeof AgentCreateInputSchema>
export type AgentPreviewRequest = z.infer<typeof AgentPreviewRequestSchema>
export type AgentPreview = z.infer<typeof AgentPreviewSchema>
export type AgentOperation = z.infer<typeof AgentOperationSchema>
export type ProfileStepName = z.infer<typeof ProfileStepNameSchema>
