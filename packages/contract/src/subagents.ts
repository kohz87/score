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
