import type { SubagentSetup } from '@score/contract'
import { z } from 'zod'
import { AgentPreviewSchema, type AgentCreateInput, type ProfileStepName } from '@score/contract'
import type { Baseline } from './approvals.ts'

export const ProfileInventorySchema = z.object({
  exists: z.boolean(),
  identity: z.string().nullable(),
  revision: z.string(),
  inherited: AgentPreviewSchema.shape.inherited,
  blockers: z.array(z.string()),
})
export type ProfileInventory = z.infer<typeof ProfileInventorySchema>
export interface ProfileStepContext {
  operationId: string
  targetName: string
  targetIdentity: string | null
  createdAt: string
  input: AgentCreateInput | null
  baseline: Baseline
  /** Never globs of the baseline already applied (a rebaseline replaces them; the rest of the deny list is Hermes's). */
  previousNever?: string[]
  exportPath: string | null
  /** Import only: the stored archive handed to `hermes profile import`. */
  importArchive?: string | null
}
/** `delegation.*` in a profile's Hermes config; null: not set, or (timeout) no limit. */
export interface HermesSubagentConfig {
  maxConcurrent: number | null
  model: string | null
  maxIterations: number | null
  timeoutSeconds: number | null
}

export interface SubagentSetupPort {
  /** Whether each Hermes agent is set up for subagents (docs/API-CONTRACT.md §19). */
  subagentSetup(): Promise<SubagentSetup>
  /** Only when the person presses Apply. */
  applySubagentSetup(agentIds: string[]): Promise<SubagentSetup>
  /** A job's limits or count changed: every session of the job gets them, for its next `delegate_task`. */
  refreshSubagentPolicies(jobId: string): void
  /** The Hermes part of an agent's ceiling. */
  subagentConfig(agentId: string): Promise<HermesSubagentConfig>
  setSubagentConfig(agentId: string, change: Partial<HermesSubagentConfig>): Promise<void>
}

export interface ProfileManagementPort {
  profileInventory(name: string, cloneFrom?: string): Promise<ProfileInventory>
  profileExportPath(name: string, revision: string): string
  profileStep(
    step: ProfileStepName,
    context: ProfileStepContext,
  ): Promise<{ identity: string | null }>
  describeProfile(name: string, description: string): Promise<void>
}
