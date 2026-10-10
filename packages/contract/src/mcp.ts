import { z } from 'zod'
import { AgentIdSchema } from './types.ts'

// Contract §13 "MCP access" (PLAN 7.4d). Score serves MCP to its agents on the loopback bridge listener
// (`/bridge/mcp`); these schemas are the browser's view of the per-agent switches and the token.

/** Per-agent bearer tokens: `scm_` + 43 base64url characters. The prefix keeps them distinct from bridge tokens. */
export const MCP_TOKEN_PATTERN = /^scm_[A-Za-z0-9_-]{43}$/
export const MCP_POSTS_PER_HOUR = 30
export const MCP_CALLS_PER_MINUTE = 120

export const McpAccessSchema = z.object({
  agentId: AgentIdSchema,
  /** Master switch: off by default; also gates the read tools. */
  enabled: z.boolean(),
  /** Gates rooms.post, tasks.comment and knowledge.write; off by default. */
  writesEnabled: z.boolean(),
  hasToken: z.boolean(),
  tokenCreatedAt: z.iso.datetime().nullable(),
  /** False when Score has no loopback bridge listener (local single-port mode): the tools cannot be reached. */
  available: z.boolean(),
  /** The URL the agent connects to; null when not available. */
  url: z.string().nullable(),
  /** The command the owner runs by hand to add the entry to the profile; Score never runs it. Null when not available. */
  command: z.string().nullable(),
  /** Posts (rooms.post + tasks.comment) in the last hour, against `postLimitPerHour`. */
  postsThisHour: z.int().nonnegative(),
  postLimitPerHour: z.int().positive(),
})
export type McpAccess = z.infer<typeof McpAccessSchema>

export const McpAccessPatchSchema = z
  .object({ enabled: z.boolean().optional(), writesEnabled: z.boolean().optional() })
  .strict()
  .refine((body) => body.enabled !== undefined || body.writesEnabled !== undefined)
export type McpAccessPatch = z.infer<typeof McpAccessPatchSchema>

/** Returned once, when a token is created or rotated; Score keeps only a hash. */
export const McpTokenIssuedSchema = z.object({
  token: z.string().regex(MCP_TOKEN_PATTERN),
  access: McpAccessSchema,
})
export type McpTokenIssued = z.infer<typeof McpTokenIssuedSchema>
