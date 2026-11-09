import { z } from 'zod'

export const RuntimeSchema = z.enum(['hermes', 'claude-code', 'codex', 'antigravity'])
export type Runtime = z.infer<typeof RuntimeSchema>
/** Where a run's cost came from: the CLI/provider reported it, it is an API-price equivalent, or nothing says. */
export const CostKindSchema = z.enum(['reported', 'estimated', 'unknown'])
export type CostKind = z.infer<typeof CostKindSchema>
