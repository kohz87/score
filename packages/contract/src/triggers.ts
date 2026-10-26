import { z } from 'zod'

// Webhook triggers, job sources and report-back (PLAN 11.1d; docs/briefs/11.1d-sources.md, docs/briefs/11.0-bold.md §7).
// An outside app calls `POST /hooks/<triggerId>` with a Standard Webhooks signature; a call starts a job in the team
// room. Score holds only its own signing secret, never an app's credential: report-back is a constrained lead turn
// that calls a tool of the lead's Hermes profile, confirmed by the bridge's record of that call.

export const TRIGGER_LIMITS = {
  bodyBytes: 256 * 1024,
  callsPerMinute: 60,
  /** Standard Webhooks timestamp tolerance. */
  toleranceSeconds: 300,
  /** How long a `webhook-id` is remembered (idempotency). */
  idempotencyHours: 24,
  templateChars: 4000,
  /** A trigger's job starts with this spend cap (the person can raise it on the job), so a caller can't spend freely. */
  jobSpendCapUsd: 5,
  /** Open jobs (not done, closed or deleted) one trigger may have; past it calls answer 429 until some finish. */
  openJobs: 10,
  /** Jobs one trigger may start in 24 hours; past it calls answer 429. */
  jobsPerDay: 100,
} as const

/** A JSON path into the payload: dot-separated keys and array indexes (`ticket.title`, `items.0.id`). */
const JsonPathSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/,
    'A path is keys separated by dots, like ticket.title',
  )

export const TriggerMappingSchema = z
  .object({
    /** Required: what the job is about in the app (shown on the job tab: "TCK-142"). */
    ref: JsonPathSchema,
    title: JsonPathSchema.optional(),
    link: JsonPathSchema.optional(),
    details: JsonPathSchema.optional(),
  })
  .strict()
export type TriggerMapping = z.infer<typeof TriggerMappingSchema>

export const ReportBackSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }).strict(),
  z
    .object({
      /** Every job of this trigger reports back by calling `tool` with `args` (a JSON template with {{holes}}). */
      mode: z.literal('fixed'),
      tool: z.string().min(1).max(200),
      args: z.string().min(2).max(4000),
    })
    .strict(),
  z
    .object({
      /** As `fixed`, but the person confirms the first report-back of the trigger. */
      mode: z.literal('lead_decides'),
      tool: z.string().min(1).max(200),
      args: z.string().min(2).max(4000),
    })
    .strict(),
])
export type ReportBack = z.infer<typeof ReportBackSchema>

export const TriggerSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  app: z.string(),
  mapping: TriggerMappingSchema,
  template: z.string(),
  reportBack: ReportBackSchema,
  /** Where an app sends calls: `<public origin>/hooks/<id>`; null when Score is reachable only on this machine. */
  url: z.string().nullable(),
  /** The last call's payload, redacted (the sample the mapping is built from). */
  sample: z.unknown().nullable(),
  lastCalledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** Set when the report-back tool doesn't look like a reporting tool ("may change things, not just report"). */
  warning: z.string().optional(),
})
export type Trigger = z.infer<typeof TriggerSchema>

export const TriggerCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    app: z.string().trim().min(1).max(100),
    mapping: TriggerMappingSchema,
    template: z.string().min(1).max(TRIGGER_LIMITS.templateChars),
    reportBack: ReportBackSchema,
  })
  .strict()
export const TriggerUpdateRequestSchema = TriggerCreateRequestSchema.partial().strict()
/** The signing secret, shown in full on creation and on rotation, and again only to a paired browser. */
export const TriggerSecretSchema = z.object({
  secret: z.string().regex(/^whsec_[A-Za-z0-9+/]+=*$/),
})
export const TriggerCreatedSchema = z.object({ trigger: TriggerSchema, secret: z.string() })
export const TriggersResponseSchema = z.object({ items: z.array(TriggerSchema) })

/** `Job.source`: where a job came from, for the "Started by" card and the tab's reference. */
export const JobSourceSchema = z.object({
  app: z.string(),
  ref: z.string(),
  title: z.string().nullable(),
  link: z.string().nullable(),
  triggerId: z.string().min(1),
  /** Mapped fields the call didn't have ("ticket.title"): the job still started. */
  missing: z.array(z.string()),
})
export type JobSource = z.infer<typeof JobSourceSchema>

/** `Job.reportBack`: the report-back of a job started by a trigger. */
export const JobReportBackSchema = z.object({
  state: z.enum(['waiting', 'needs_ok', 'sending', 'confirmed', 'not_confirmed', 'off']),
  tool: z.string().nullable(),
  at: z.iso.datetime().nullable(),
})
export type JobReportBack = z.infer<typeof JobReportBackSchema>
