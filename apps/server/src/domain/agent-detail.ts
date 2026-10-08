import { AgentSummarySchema } from '@score/contract'
import { z } from 'zod'

// Temporary §8 validator until the shared contract exports AgentDetail (see task report).
export const AgentDetailSchema = AgentSummarySchema.extend({
  tagline: z.string(),
  personality: z.object({ excerpt: z.string().max(280), source: z.literal('SOUL.md') }),
  reportsTo: z.string().min(1).nullable(),
  worksIn: z.string().nullable(),
  rulesFile: z.literal('AGENTS.md').nullable(),
  model: z.object({
    id: z.string().min(1),
    label: z.string(),
    via: z.string(),
    fallback: z.string().nullable(),
  }),
  skills: z.array(z.object({ name: z.string(), enabled: z.boolean() })),
  memory: z.array(
    z.object({ id: z.string(), text: z.string(), source: z.string(), at: z.iso.datetime() }),
  ),
  tools: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.enum(['builtin', 'mcp']),
      enabled: z.boolean(),
    }),
  ),
  helpersMax: z.int().nonnegative().nullable(),
  routines: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      schedule: z.string(),
      description: z.string(),
      lastRunAt: z.iso.datetime().nullable(),
      enabled: z.boolean(),
    }),
  ),
  channels: z.array(z.object({ platform: z.string(), label: z.string(), connected: z.boolean() })),
  permissions: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      level: z.enum(['allowed', 'asks', 'never']),
      inherited: z.boolean(),
    }),
  ),
})
export type AgentDetail = z.infer<typeof AgentDetailSchema>
