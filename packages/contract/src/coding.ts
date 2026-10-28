import { z } from 'zod'
import { AgentIdSchema, AgentStyleSchema } from './types.ts'
import { ProfileNameSchema } from './profiles.ts'

// §8 Coding agents (PLAN 7.2, 7.6): Claude Code, Codex CLI and Antigravity (agy) as team members.

export const CodingRuntimeSchema = z.enum(['claude-code', 'codex', 'antigravity'])
export type CodingRuntime = z.infer<typeof CodingRuntimeSchema>

/** `read-only` reads; `workspace-write` (default) edits inside the workspace; `full` needs the security password. */
export const CodingPermissionSchema = z.enum(['read-only', 'workspace-write', 'full'])
export type CodingPermission = z.infer<typeof CodingPermissionSchema>

export const CliStateSchema = z.enum([
  'ready',
  'not_installed',
  /** Known, but this Score cannot drive it yet. */
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

/** The quota floor (PLAN 8.6, decision 91): stop giving a coding agent new steps below this share left; 0 = off. */
export const QuotaFloorSchema = z.int().min(0).max(50)
export const DEFAULT_QUOTA_FLOOR_PERCENT = 10

/** Longest "Personality and instructions" text of a coding agent (PLAN 8.8, decision 94). */
export const CODING_INSTRUCTIONS_MAX = 8000
const InstructionsSchema = z.string().max(CODING_INSTRUCTIONS_MAX)

/**
 * Reasoning effort per coding runtime (3.9.0, decision 147). Claude Code: `claude --help` 2.1.311 "--effort <level>
 * (low, medium, high, xhigh, max)". Codex: `model_reasoning_effort`; the chosen model's own list wins when known. Antigravity
 * documents no effort flag. A level is also a strict `^[a-z]{1,12}$` word: it travels on argv.
 */
export const CODING_EFFORTS: Partial<Record<CodingRuntime, readonly string[]>> = {
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
}
export const EffortWordSchema = z.string().regex(/^[a-z]{1,12}$/)

/**
 * 3.14.1 (owner): a Claude Code agent's own advisor (Claude Code's `--advisor`, code.claude.com/docs/en/advisor). The
 * advisor must rank above the agent's model (haiku < sonnet < opus < fable); an agent on the CLI default can take only Fable.
 */
export const CLAUDE_ADVISOR_MODELS = ['sonnet', 'opus', 'fable'] as const
export const ClaudeAdvisorModelSchema = z.enum(CLAUDE_ADVISOR_MODELS)
const MODEL_RANKS: [RegExp, number][] = [
  [/haiku/i, 1],
  [/sonnet/i, 2],
  [/opus/i, 3],
  [/fable/i, 4],
]
/** The family rank of a Claude model id or alias; null when unknown (the CLI default counts as Opus). */
export function claudeModelRank(model: string | null): number | null {
  if (model === null) return 3
  return MODEL_RANKS.find(([pattern]) => pattern.test(model))?.[1] ?? null
}
/** The advisor models a Claude Code agent on `model` may take (strictly above it). */
export function advisorChoicesFor(model: string | null): (typeof CLAUDE_ADVISOR_MODELS)[number][] {
  const rank = claudeModelRank(model)
  if (rank === null) return []
  return CLAUDE_ADVISOR_MODELS.filter((choice) => claudeModelRank(choice)! > rank)
}

export const CodingAgentSchema = z.object({
  id: AgentIdSchema,
  name: z.string(),
  role: z.string(),
  /** The owner's "Personality and instructions" (Markdown), handed to the CLI each session. */
  instructions: z.string(),
  /** Identifies `instructions` for an edit: send it back as `instructionsEtag` when saving. */
  instructionsEtag: z.string().min(1).max(64),
  runtime: CodingRuntimeSchema,
  workspace: z.string(),
  permission: CodingPermissionSchema,
  model: z.string().nullable(),
  /** Reasoning effort passed to the CLI; null = Default (nothing sent). Claude Code and Codex only. */
  effort: EffortWordSchema.nullable().default(null),
  /** 3.14.1: Claude Code only: the agent's own advisor model (`--advisor`) on every turn; null = none. */
  advisorModel: ClaudeAdvisorModelSchema.nullable().default(null),
  style: AgentStyleSchema,
  quota: z.string(),
  /** Runs stop giving this agent new steps while a limit has less than this share left (0 = off; default 10). */
  quotaFloorPercent: QuotaFloorSchema,
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
    instructions: InstructionsSchema.default(''),
    runtime: CodingRuntimeSchema,
    /** Absolute folder (`~/` allowed). Default `~/score-workspaces/<id>`, created on demand. */
    workspace: z.string().min(1).max(4096).optional(),
    permission: CodingPermissionSchema.default('workspace-write'),
    model: ModelSchema.optional(),
    style: AgentStyleSchema,
    quotaFloorPercent: QuotaFloorSchema.optional(),
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
    instructions: InstructionsSchema.optional(),
    /** Required with `instructions`: the `instructionsEtag` the edit started from (`409 conflict` when stale). */
    instructionsEtag: z.string().min(1).max(64).optional(),
    permission: CodingPermissionSchema.optional(),
    model: ModelSchema.nullable().optional(),
    /** null = Default. The level must be in the runtime's list (`CODING_EFFORTS`); else `400`. */
    effort: EffortWordSchema.nullable().optional(),
    /** 3.14.1: null = none; Claude Code only, and above the agent's model (`advisorChoicesFor`); else `400`. */
    advisorModel: ClaudeAdvisorModelSchema.nullable().optional(),
    workspace: z.string().min(1).max(4096).optional(),
    quotaFloorPercent: QuotaFloorSchema.optional(),
    password: z.string().max(1024).optional(),
  })
  .strict()
  .refine((value) =>
    Object.keys(value).some((key) => key !== 'password' && key !== 'instructionsEtag'),
  )
  .refine((value) => value.instructions === undefined || value.instructionsEtag !== undefined, {
    message: 'instructionsEtag is required with instructions',
    path: ['instructionsEtag'],
  })
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

/**
 * A coding CLI's own quota meters (PLAN 8.1, decision 82). One shape for all three CLIs. `usedPercent` is the share of
 * the window already used (the web shows "% left"); null when the CLI didn't say. `group` names the model group
 * (Antigravity) and is null otherwise.
 */
export const CodingQuotaWindowSchema = z.object({
  name: z.enum(['5 hours', 'week']),
  group: z.string().min(1).max(100).nullable(),
  usedPercent: z.number().min(0).max(100).nullable(),
  resetsAt: z.iso.datetime().nullable(),
})
export const CodingQuotaSchema = z.object({
  runtime: CodingRuntimeSchema,
  seenAt: z.iso.datetime(),
  windows: z.array(CodingQuotaWindowSchema).max(24),
  source: z.enum(['usage', 'turn', 'log']),
})
export type CodingQuotaWindow = z.infer<typeof CodingQuotaWindowSchema>
export type CodingQuota = z.infer<typeof CodingQuotaSchema>
/** `GET /api/coding-agents/:id/quota` and `GET /api/coding-agents/runtimes/:runtime/quota`: null until a reading exists. */
export const CodingQuotaResponseSchema = z.object({ quota: CodingQuotaSchema.nullable() })
export type CodingQuotaResponse = z.infer<typeof CodingQuotaResponseSchema>

/**
 * The models a coding CLI offers (PLAN 8.5, decision 86). `source`: `cli` = the CLI's own listing command, `cache` = the
 * model cache the CLI keeps, `aliases` = a fixed list of documented names, `none` = nothing readable (free text only).
 */
export const CodingModelOptionSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  efforts: z.array(z.string().min(1).max(40)).max(12).optional(),
})
export const CodingModelsResponseSchema = z.object({
  models: z.array(CodingModelOptionSchema).max(200),
  source: z.enum(['cli', 'cache', 'aliases', 'none']),
})
export type CodingModelOption = z.infer<typeof CodingModelOptionSchema>
export type CodingModelsResponse = z.infer<typeof CodingModelsResponseSchema>
