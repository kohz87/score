import { z } from 'zod'
import { AgentIdSchema } from './types.ts'
import { ORCH_ACKNOWLEDGEMENT_TEXT } from './orchestration.ts'
import { ChatModelNameSchema } from './chat-models.ts'
import { RoutineSummarySchema } from './routines.ts'

/**
 * Decision 183 (contract section 22): Tasks › Repeating and Tasks › Recipes. Repeating jobs are standalone, like
 * workspaces: one list across agents, each assigned to an agent (a Hermes cron job in that agent's profile) or to a
 * recipe (a schedule Score itself runs). A schedule is what Hermes' scheduler takes: a 5-field cron expression or
 * `every <n><m|h|d>`, in an IANA time zone.
 */

/** An agent's job takes whatever Hermes' scheduler takes (cron, `every 2h`, `30m`, a time), on one line. */
export const RoutineScheduleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\r\n]+$/)
/** A recipe's schedule, which Score runs itself: a 5-field cron expression, or `every <n><m|h|d>`. */
export const ScheduleTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^(?:every \d{1,4}[mhd]|[0-9*,\-/]+ [0-9*,\-/]+ [0-9*,\-/]+ [0-9*,\-/]+ [0-9*,\-/]+)$/)
export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$|^UTC$/)

/** Where a repeating job's result goes: a Score chat (the job's output is posted there as the agent's message), or
 * nowhere (it stays in the agent's runs). */
export const DeliverToSchema = z
  .object({ roomId: z.string().min(1), roomName: z.string() })
  .nullable()
export type DeliverTo = z.infer<typeof DeliverToSchema>

/** A model pinned on a repeating job or set on a recipe step; absent or null follows the agent's own. */
export const PinnedModelSchema = z.object({
  model: ChatModelNameSchema,
  provider: z.string().min(1).max(100).nullable(),
})
export type PinnedModel = z.infer<typeof PinnedModelSchema>

/** One agent's repeating job, as the list across agents shows it. */
export const RepeatingJobSchema = RoutineSummarySchema.extend({
  agentId: AgentIdSchema,
  /** Hermes's next fire time, when it says. */
  nextRunAt: z.iso.datetime().nullable(),
  provider: z.string().nullable(),
  deliverTo: DeliverToSchema,
})
export type RepeatingJob = z.infer<typeof RepeatingJobSchema>

/** `GET /api/routines`: every agent's repeating jobs. An agent whose jobs couldn't be read is listed in `unreadable`. */
export const RepeatingJobsResponseSchema = z.object({
  items: z.array(RepeatingJobSchema),
  unreadable: z.array(AgentIdSchema),
})
export type RepeatingJobsResponse = z.infer<typeof RepeatingJobsResponseSchema>

/** `POST /api/agents/:agentId/routines` (decision 183 adds the optional fields). */
export const CreateRepeatingJobSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\r\n]+$/),
    schedule: RoutineScheduleSchema,
    // An argument to the Hermes CLI: never a NUL.
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(32000)
      .refine((value) => !value.includes('\0')),
    timezone: TimeZoneSchema.optional(),
    model: PinnedModelSchema.nullish(),
    deliverTo: z.string().min(1).nullish(),
  })
  .strict()
export type CreateRepeatingJob = z.infer<typeof CreateRepeatingJobSchema>

/** `PATCH /api/routines/:id`: any of these; `model: null` unpins (follows the agent), `deliverTo: null` sends nowhere. */
export const PatchRepeatingJobSchema = z
  .object({
    enabled: z.boolean().optional(),
    title: CreateRepeatingJobSchema.shape.title.optional(),
    schedule: RoutineScheduleSchema.optional(),
    prompt: CreateRepeatingJobSchema.shape.prompt.optional(),
    timezone: TimeZoneSchema.optional(),
    model: PinnedModelSchema.nullable().optional(),
    deliverTo: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Say what to change.')
export type PatchRepeatingJob = z.infer<typeof PatchRepeatingJobSchema>

/** `POST /api/routines/:id/move`: create the job for another agent, then remove it from this one. Answers with the new
 * job; when the removal fails, `leftBehind` is the old id (both exist; the person removes one). */
export const MoveRepeatingJobSchema = z.object({ agentId: AgentIdSchema }).strict()
export const MovedRepeatingJobSchema = z.object({
  job: RepeatingJobSchema,
  leftBehind: z.string().min(1).nullable(),
})
export type MovedRepeatingJob = z.infer<typeof MovedRepeatingJobSchema>

/** A recipe's schedule: Score starts one run per fire, as a job in `roomId`. Score must be running at that time; a fire
 * it missed is recorded as `missed` (never run late on its own). */
export const RecipeScheduleSchema = z.object({
  workflowId: z.string().min(1),
  recipeName: z.string(),
  schedule: ScheduleTextSchema,
  timezone: TimeZoneSchema,
  roomId: z.string().min(1),
  roomName: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.iso.datetime().nullable(),
  lastRun: z
    .object({
      at: z.iso.datetime(),
      outcome: z.enum(['started', 'missed', 'failed']),
      /** The run it started (`started`). */
      briefId: z.string().nullable(),
      /** Plain words for `failed`. */
      reason: z.string().nullable(),
    })
    .nullable(),
})
export type RecipeSchedule = z.infer<typeof RecipeScheduleSchema>

/** `GET /api/recipe-schedules`. */
export const RecipeSchedulesResponseSchema = z.object({ items: z.array(RecipeScheduleSchema) })
export type RecipeSchedulesResponse = z.infer<typeof RecipeSchedulesResponseSchema>

/** `PUT /api/workflows/:workflowId/schedule`: set or replace a recipe's schedule. */
export const RecipeScheduleRequestSchema = z
  .object({
    schedule: ScheduleTextSchema,
    timezone: TimeZoneSchema,
    roomId: z.string().min(1),
    enabled: z.boolean(),
    /** What the person saw when setting it, as when starting a run: each run is bound to these agents (an agent
     * changed since makes that run fail with the reason) and to this acknowledgement. */
    agentMap: z
      .array(z.object({ agentId: AgentIdSchema, incarnation: z.string().min(1) }).strict())
      .max(30),
    acknowledgement: z.object({ text: z.literal(ORCH_ACKNOWLEDGEMENT_TEXT) }),
  })
  .strict()
export type RecipeScheduleRequest = z.infer<typeof RecipeScheduleRequestSchema>

/** `GET /api/agents/:agentId/assigned`: what's assigned to an agent, for the agent page's Work and the direct chat's
 * Info (read-only; set in Tasks). Tasks come from the Tasks board's own query. */
export const AgentAssignedSchema = z.object({
  agentId: AgentIdSchema,
  repeating: z.array(RepeatingJobSchema),
  recipeSteps: z.array(
    z.object({
      workflowId: z.string().min(1),
      recipeName: z.string(),
      stepLabel: z.string(),
      /** The recipe's schedule: only recipes that repeat assign their steps' agents work. */
      schedule: ScheduleTextSchema.nullable(),
    }),
  ),
})
export type AgentAssigned = z.infer<typeof AgentAssignedSchema>
