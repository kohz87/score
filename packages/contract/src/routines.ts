import { z } from 'zod'

// An agent's repeating jobs (Hermes cron), as the agent page and the routes show them.
export const RoutineSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  schedule: z.string(),
  description: z.string(),
  lastRunAt: z.iso.datetime().nullable(),
  enabled: z.boolean(),
  /** Decision 182: the model the job is pinned to; null (or absent) follows the agent's model when it runs. */
  model: z.string().nullish(),
  /** Decision 183: Hermes's next fire time and the pinned model's provider, when it says. */
  nextRunAt: z.iso.datetime().nullish(),
  provider: z.string().nullish(),
})
export type RoutineSummary = z.infer<typeof RoutineSummarySchema>
