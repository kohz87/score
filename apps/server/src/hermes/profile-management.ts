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
  exportPath: string | null
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
