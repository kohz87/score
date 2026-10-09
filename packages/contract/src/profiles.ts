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
/** Largest archive Score accepts for import (compressed bytes). */
export const PROFILE_IMPORT_MAX_BYTES = 200 * 1024 * 1024
export const ProfileImportUploadIdSchema = z.uuid()
export const AgentImportRequestSchema = z
  .object({
    uploadId: ProfileImportUploadIdSchema,
    id: ProfileNameSchema,
    name: Text.max(100),
    role: Text,
    style: AgentStyleSchema,
    /** Required when the archive carries credential files; Hermes copies them into the new profile. */
    confirmCredentials: z.boolean().optional(),
  })
  .strict()
/** What Score found inside an uploaded archive without extracting it. Names and counts only, never contents. */
export const ImportInspectionSchema = z.object({
  uploadId: ProfileImportUploadIdSchema,
  sizeBytes: z.int().nonnegative(),
  /** The archive's single top-level directory (the exporting profile's name). */
  archiveRoot: z.string(),
  /** Suggested new agent id: the archive root when it is a valid, non-reserved profile name. */
  suggestedId: ProfileNameSchema.nullable(),
  description: z.string().nullable(),
  model: z.string().nullable(),
  /** Hermes config schema version recorded in config.yaml (the archive carries no Hermes release number). */
  configVersion: z.string().nullable(),
  skills: z.array(z.string()),
  plugins: z.array(z.string()),
  memoryBytes: z.int().nonnegative(),
  fileCount: z.int().nonnegative(),
  totalBytes: z.int().nonnegative(),
  /** Paths of credential files inside the archive (.env, auth.json, …). Their contents are never read. */
  credentialFiles: z.array(z.string()),
  hasBridge: z.boolean(),
  warnings: z.array(z.string()),
})
export const ProfileStepNameSchema = z.enum([
  'create_profile',
  'import_profile',
  'describe_profile',
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
  kind: z.enum(['create', 'delete', 'import']),
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
export type AgentImportRequest = z.infer<typeof AgentImportRequestSchema>
export type ImportInspection = z.infer<typeof ImportInspectionSchema>
export type AgentPreview = z.infer<typeof AgentPreviewSchema>
export type AgentOperation = z.infer<typeof AgentOperationSchema>
export type ProfileStepName = z.infer<typeof ProfileStepNameSchema>
