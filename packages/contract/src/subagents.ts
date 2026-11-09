import { z } from 'zod'
import { AgentIdSchema } from './types.ts'

/**
 * Subagents: an agent's own throwaway helpers (decision 173, docs/briefs/SA-subagents.md). Without the setting below a
 * Hermes agent's subagents can't report back, be stopped or ask for approval, so Score refuses them until it's on.
 */
export const SubagentSetupAgentSchema = z.object({
  agentId: AgentIdSchema,
  /** `delegation.gateway_mode: inline` is set on this profile. */
  inline: z.boolean(),
  /** The installed plugin has the guard that keeps subagents inside their limits; without it the setting can't be applied. */
  guard: z.boolean(),
})
export type SubagentSetupAgent = z.infer<typeof SubagentSetupAgentSchema>

/** `GET /api/subagent-setup`, and the answer to applying it. */
export const SubagentSetupSchema = z.object({ agents: z.array(SubagentSetupAgentSchema) })
export type SubagentSetup = z.infer<typeof SubagentSetupSchema>

/** `POST /api/subagent-setup/apply`: only when the person presses Apply. */
export const ApplySubagentSetupSchema = z.object({
  agentIds: z.array(AgentIdSchema).min(1).max(64),
})
export type ApplySubagentSetup = z.infer<typeof ApplySubagentSetupSchema>

export const SUBAGENT_LIMITS = {
  /** The owner's default (decision 173): on, up to 4. */
  defaultConcurrent: 4,
  /** The lead's default: a total per job, then the job pauses and asks. */
  defaultTotal: 20,
  maxConcurrent: 16,
  maxTotal: 500,
  /** "Allow N more" at a pause. */
  moreMax: 200,
} as const

const Concurrent = z.int().min(1).max(SUBAGENT_LIMITS.maxConcurrent)
const Total = z.int().min(1).max(SUBAGENT_LIMITS.maxTotal)

/** A job's limits. They can only narrow the agent's: `maxConcurrent` null means the agent's own. */
export const JobSubagentsSchema = z.object({
  enabled: z.boolean(),
  maxConcurrent: Concurrent.nullable(),
  maxTotal: Total,
  /** Started in this job so far. */
  used: z.int().nonnegative(),
})
export type JobSubagents = z.infer<typeof JobSubagentsSchema>

/** One subagent, for the chat's status card and the job map. Its steps stay in Watch. */
export const SubagentRowSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  /** Its parent, the agent on the team. */
  agentId: AgentIdSchema,
  goal: z.string(),
  state: z.enum(['running', 'done', 'failed']),
  /** An approval from it is open. */
  waitingOnYou: z.boolean(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  /** Dollars once its parent's turn ends; null when unknown, and where a route has no dollars (see `tokens`). */
  costUsd: z.number().nonnegative().nullable(),
  tokens: z.int().nonnegative().nullable(),
})
export type SubagentRow = z.infer<typeof SubagentRowSchema>

/** `GET /api/jobs/:jobId/subagents`. */
export const SubagentRowsResponseSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  items: z.array(SubagentRowSchema),
})

/** `subagents.changed`: a job's limits or count moved. Sent for every room. */
export const SubagentsChangedSchema = z.object({
  jobId: z.string().min(1),
  roomId: z.string().min(1),
  subagents: JobSubagentsSchema,
})

/** `PUT /api/jobs/:jobId/subagents` (the `/subagents` command, the context bar), and Start a job's choice. */
export const JobSubagentsRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxConcurrent: Concurrent.nullable().optional(),
    maxTotal: Total.optional(),
  })
  .strict()
export type JobSubagentsRequest = z.infer<typeof JobSubagentsRequestSchema>

/**
 * What Score can do about an agent's subagents, which depends on its program: `limits` (Hermes), `on_off` (Claude Code
 * decides how many at once), `none` (Codex: Score can't turn them off or follow them yet).
 */
export const SubagentControlSchema = z.enum(['limits', 'on_off', 'none'])

/** `GET`/`PUT /api/agents/:agentId/subagents`: the agent's ceiling. */
export const AgentSubagentsSchema = z.object({
  agentId: AgentIdSchema,
  control: SubagentControlSchema,
  enabled: z.boolean(),
  maxConcurrent: Concurrent,
  /** Hermes only; null elsewhere, or when Hermes couldn't be read. Model null also means the same as the agent's. */
  model: z.string().nullable(),
  maxIterations: z.int().positive().nullable(),
  /** Null: no limit. */
  timeoutSeconds: z.int().positive().nullable(),
})
export type AgentSubagents = z.infer<typeof AgentSubagentsSchema>

export const AgentSubagentsRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxConcurrent: Concurrent.optional(),
    model: z.string().trim().min(1).max(200).nullable().optional(),
    maxIterations: z.int().min(1).max(1000).optional(),
    timeoutSeconds: z.int().min(1).max(86_400).nullable().optional(),
  })
  .strict()
export type AgentSubagentsRequest = z.infer<typeof AgentSubagentsRequestSchema>
