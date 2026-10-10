import { z } from 'zod'
import { AgentIdSchema, AgentStyleSchema } from './types.ts'
import { ProfileNameSchema } from './profiles.ts'

// §8 Coding agents (PLAN 7.2): Claude Code, Codex CLI and OpenCode as team members.

export const CodingRuntimeSchema = z.enum(['claude-code', 'codex', 'opencode'])
export type CodingRuntime = z.infer<typeof CodingRuntimeSchema>

/** `read-only` reads; `workspace-write` (default) edits inside the workspace; `full` needs the security password. */
export const CodingPermissionSchema = z.enum(['read-only', 'workspace-write', 'full'])
export type CodingPermission = z.infer<typeof CodingPermissionSchema>

export const CliStateSchema = z.enum([
  'ready',
  'not_installed',
  /** Known, but this Score cannot drive it yet (OpenCode). */
  'not_supported',
  /** Installed, but its version is not one of the tested versions: runs only after the person confirms that version. */
  'untested_version',
])
export type CliState = z.infer<typeof CliStateSchema>

export const CodingRuntimeInfoSchema = z.object({
  runtime: CodingRuntimeSchema,
  label: z.string(),
  state: CliStateSchema,
  version: z.string().nullable(),
  /** Exact versions Score was tested with, e.g. `2.1.295`. */
  testedVersions: z.array(z.string()),
  /** "Uses your Claude plan quota" and the like. */
  quota: z.string(),
  /** Why it cannot run, when it cannot. */
  message: z.string().nullable(),
})
export type CodingRuntimeInfo = z.infer<typeof CodingRuntimeInfoSchema>
export const CodingRuntimesResponseSchema = z.object({ items: z.array(CodingRuntimeInfoSchema) })

export const CodingAgentSchema = z.object({
  id: AgentIdSchema,
  name: z.string(),
  role: z.string(),
  runtime: CodingRuntimeSchema,
  workspace: z.string(),
  permission: CodingPermissionSchema,
  model: z.string().nullable(),
  style: AgentStyleSchema,
  quota: z.string(),
  cli: z.object({
    state: CliStateSchema,
    version: z.string().nullable(),
    testedVersions: z.array(z.string()),
    /** The person confirmed the installed (untested) version for this agent. */
    confirmed: z.boolean(),
  }),
  createdAt: z.iso.datetime(),
})
export type CodingAgent = z.infer<typeof CodingAgentSchema>
export const CodingAgentsResponseSchema = z.object({ items: z.array(CodingAgentSchema) })

const NameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => !/[\r\n\0]/.test(value))
const ModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/)

export const CodingAgentCreateSchema = z
  .object({
    id: ProfileNameSchema,
    name: NameSchema,
    role: z.string().max(2000).default(''),
    runtime: CodingRuntimeSchema,
    /** Absolute folder (`~/` allowed). Default `~/score-workspaces/<id>`, created on demand. */
    workspace: z.string().min(1).max(4096).optional(),
    permission: CodingPermissionSchema.default('workspace-write'),
    model: ModelSchema.optional(),
    style: AgentStyleSchema,
    /** The security password; required when `permission` is `full`. */
    password: z.string().max(1024).optional(),
    /**
     * Codex can read every file the owner's user can (its sandbox limits writes and commands, not reads; live-checked
     * 2026-10-10). Creating a Codex agent requires this acknowledgement (owner decision: allow with a clear warning).
     */
    acknowledgeReads: z.literal(true).optional(),
  })
  .strict()
export type CodingAgentCreate = z.infer<typeof CodingAgentCreateSchema>

export const CodingAgentPatchSchema = z
  .object({
    name: NameSchema.optional(),
    role: z.string().max(2000).optional(),
    permission: CodingPermissionSchema.optional(),
    model: ModelSchema.nullable().optional(),
    workspace: z.string().min(1).max(4096).optional(),
    password: z.string().max(1024).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'password'))
export type CodingAgentPatch = z.infer<typeof CodingAgentPatchSchema>

export const CodingVersionConfirmSchema = z.object({ version: z.string().min(1).max(100) }).strict()
