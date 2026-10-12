import { z } from 'zod'
import { AgentIdSchema, AgentStyleSchema } from './types.ts'
import { ProfileNameSchema } from './profiles.ts'

// §8 Coding agents (PLAN 7.2, 7.6): Claude Code, Codex CLI and Antigravity (agy) as team members; OpenCode is listed only.

export const CodingRuntimeSchema = z.enum(['claude-code', 'codex', 'antigravity', 'opencode'])
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
  /** Permission levels Score has not verified for this CLI yet: shown disabled and refused on create/patch. */
  unverifiedPermissions: z.array(CodingPermissionSchema),
  /** A warning to show where the CLI is chosen (what it can do beyond editing files), or null. */
  warning: z.string().nullable(),
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
  /** Process groups Score could not prove ended: the agent takes no new turn while any is held. */
  heldGroups: z.array(
    z.object({
      runId: z.string(),
      pgid: z.int(),
      /** True when Score can't tell whether the processes are its own: the person may release the agent. */
      canRelease: z.boolean(),
      /** The supervised service the run used (7.7a), when it was one; `pgid` is then 0. */
      unit: z.string().optional(),
    }),
  ),
  createdAt: z.iso.datetime(),
})
export type CodingAgent = z.infer<typeof CodingAgentSchema>
/**
 * How coding runs are launched right now (7.7a): as supervised system services, or by the fallback that has no
 * supervisor. `checks` is the capability check behind the choice; "Check again" reruns it.
 */
export const CodingBackendSchema = z.object({
  kind: z.enum(['unit', 'process-group']),
  /** One sentence for the coding agent card. */
  note: z.string(),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })),
  checkedAt: z.iso.datetime(),
})
export type CodingBackend = z.infer<typeof CodingBackendSchema>

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
     * 2026-10-10), and so can Antigravity. Creating either needs this acknowledgement (owner decision: allow with a
     * clear warning).
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

/**
 * Antigravity's own quota (`agy -p /usage`, PLAN 7.6): per model group the 5-hour and weekly share still available.
 * A group's numbers are null when the CLI's table did not carry them; `text` is always the (redacted) table as printed.
 */
export const CodingUsageGroupSchema = z.object({
  name: z.string(),
  fiveHourRemainingPercent: z.number().min(0).max(100).nullable(),
  fiveHourResets: z.string().nullable(),
  weeklyRemainingPercent: z.number().min(0).max(100).nullable(),
  weeklyResets: z.string().nullable(),
})
export const CodingUsageSchema = z.object({
  runtime: CodingRuntimeSchema,
  fetchedAt: z.iso.datetime(),
  groups: z.array(CodingUsageGroupSchema),
  text: z.string(),
})
export type CodingUsage = z.infer<typeof CodingUsageSchema>
