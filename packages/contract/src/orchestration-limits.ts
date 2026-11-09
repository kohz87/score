import { z } from 'zod'
import { QuotaFloorSchema } from './coding.ts'
import { CostSourceSchema, ORCH_LIMITS } from './orchestration.ts'

const revision = z.int().positive()

export const LimitsDecisionSchema = z
  .object({
    budgetUsd: z.number().positive().max(10_000).nullable().optional(),
    deadlineAt: z.iso.datetime().nullable().optional(),
    /** Continue although spend is unknown (otherwise unknown spend keeps the run paused). */
    acceptUnknownSpend: z.boolean().optional(),
    /** Decision 173: at the job's subagent total, allow this many more. */
    moreSubagents: z.int().min(1).max(200).optional(),
    /** 7.7b: raise or lower how many coding launches the run may release. */
    codingSteps: z.int().min(1).max(ORCH_LIMITS.maxCodingSteps).optional(),
    /** 7.7b: accept (or stop accepting) unknown cost for single sources. */
    acceptUnknownCost: z
      .object({
        add: z.array(CostSourceSchema).max(3).optional(),
        remove: z.array(CostSourceSchema).max(3).optional(),
      })
      .strict()
      .optional(),
    /** 8.6: change the run's quota floor; `null` goes back to each coding agent's own. */
    quotaFloorPercent: QuotaFloorSchema.nullable().optional(),
    orchestrationRevision: revision,
  })
  .strict()
  .refine(
    (v) =>
      v.quotaFloorPercent !== undefined ||
      v.budgetUsd !== undefined ||
      v.deadlineAt !== undefined ||
      v.acceptUnknownSpend !== undefined ||
      v.moreSubagents !== undefined ||
      v.codingSteps !== undefined ||
      v.acceptUnknownCost !== undefined,
  )
export type LimitsDecision = z.infer<typeof LimitsDecisionSchema>
