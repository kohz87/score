import { z } from 'zod'
import { AgentIdSchema } from './types.ts'

// Contract § Workspaces (3.20.0): shared, named folders that agents are assigned to. A room may be set to one.
export const WorkspaceIdSchema = z.string().min(1).max(200)
export const WorkspaceNameSchema = z.string().trim().min(1).max(80)

export const SharedWorkspaceSchema = z.object({
  id: WorkspaceIdSchema,
  name: WorkspaceNameSchema,
  /** The resolved folder, as it passed the root policy when it was added. */
  path: z.string().min(1).max(4096),
  agentIds: z.array(AgentIdSchema),
  roomIds: z.array(z.string().min(1)),
})
export type SharedWorkspace = z.infer<typeof SharedWorkspaceSchema>

export const SharedWorkspaceListSchema = z.object({ workspaces: z.array(SharedWorkspaceSchema) })
export type SharedWorkspaceList = z.infer<typeof SharedWorkspaceListSchema>

export const SharedWorkspaceCreateRequestSchema = z.object({
  name: WorkspaceNameSchema,
  path: z.string().trim().min(1).max(4096),
  /** Make the folder (mode 0700) first when it doesn't exist; its parent must pass the same policy. */
  create: z.boolean().optional(),
})
export type SharedWorkspaceCreateRequest = z.infer<typeof SharedWorkspaceCreateRequestSchema>

export const SharedWorkspaceUpdateRequestSchema = z
  .object({
    name: WorkspaceNameSchema.optional(),
    agentIds: z.array(AgentIdSchema).max(500).optional(),
  })
  .refine((body) => body.name !== undefined || body.agentIds !== undefined, 'Nothing to change.')
export type SharedWorkspaceUpdateRequest = z.infer<typeof SharedWorkspaceUpdateRequestSchema>

export const RoomWorkspaceRequestSchema = z.object({ workspaceId: WorkspaceIdSchema.nullable() })
export type RoomWorkspaceRequest = z.infer<typeof RoomWorkspaceRequestSchema>

export const UseAsFolderRequestSchema = z.object({ agentId: AgentIdSchema })
export type UseAsFolderRequest = z.infer<typeof UseAsFolderRequestSchema>
