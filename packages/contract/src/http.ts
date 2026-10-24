import { z } from 'zod'
import { RoomProjectSchema } from './conversations.ts'
import {
  AgentIdSchema,
  AgentSummarySchema,
  CostKindSchema,
  RuntimeSchema,
  ApprovalSchema,
  HandoffSchema,
  LaneBlockSchema,
  MessageSchema,
  RefSchema,
  RoomSchema,
  RoutineSummarySchema,
  TaskColumnSchema,
  TaskSummarySchema,
} from './types.ts'

/** The event-log position a snapshot was read at; 0 on a fresh server with no events yet. */
export const AsOfSeqSchema = z.int().nonnegative()

/** Every non-2xx JSON response: `{ error: { code, message, details? } }`. */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.unknown().optional(),
  }),
})
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>

// §5 Chat
export const RoomsSnapshotSchema = z.object({
  asOfSeq: AsOfSeqSchema,
  rooms: z.array(RoomSchema),
  directs: z.array(RoomSchema),
  projects: z.array(RoomProjectSchema).default([]),
})
export const RoomDetailSnapshotSchema = z.object({
  asOfSeq: AsOfSeqSchema,
  room: RoomSchema,
  filesInPlay: z.array(z.string()),
  learned: z.array(
    z.object({ text: z.string(), savedTo: z.array(z.string()), at: z.iso.datetime() }),
  ),
})
export const MessagePageSchema = z.object({
  asOfSeq: AsOfSeqSchema,
  items: z.array(MessageSchema),
  nextCursor: z.string().nullable(),
  /** PLAN 11.2: the job these messages are from (the room's default job when none was asked for). */
  jobId: z.string().min(1).nullish(),
})

// §6 Approvals
export const ApprovalsPageSchema = z.object({
  asOfSeq: AsOfSeqSchema,
  items: z.array(ApprovalSchema),
  nextCursor: z.string().nullable(),
})

// §7 Tasks
export const TasksSnapshotSchema = z.object({
  asOfSeq: AsOfSeqSchema,
  columns: z.record(TaskColumnSchema, z.array(TaskSummarySchema)),
})

// §8 Team
export const AgentsSnapshotSchema = z.object({
  asOfSeq: AsOfSeqSchema,
  items: z.array(AgentSummarySchema),
})

// §5 Chat: commands and the message POST response
export const CommandsResponseSchema = z.object({
  items: z.array(z.object({ name: z.string().min(1), usage: z.string(), description: z.string() })),
})
export const CommandResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assign'), taskId: z.string().min(1), taskKey: z.string().min(1) }),
  z.object({ kind: z.literal('routine'), routineId: z.string().min(1) }),
  z.object({ kind: z.literal('remember'), agentIds: z.array(AgentIdSchema) }),
  z.object({ kind: z.literal('skill'), name: z.string().min(1), installed: z.boolean() }),
  z.object({ kind: z.literal('model'), model: z.string().min(1) }),
])
export type CommandResult = z.infer<typeof CommandResultSchema>
/** One attachment of `POST /api/rooms/:roomId/messages`: an upload (`/api/media`) or a workspace file, at most 10 in all. */
export const MessageAttachmentSchema = z.union([
  z.object({ mediaId: z.string().min(1), name: z.string().min(1).max(200).optional() }).strict(),
  z
    .object({
      workspace: z
        .object({
          agentId: AgentIdSchema,
          path: z.string().min(1).max(4096),
          // The workspace root the person picked the file from; a different current root is refused (409 workspace_changed).
          root: z.string().min(1).max(4096).optional(),
        })
        .strict(),
    })
    .strict(),
])
export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>
export const PostMessageResponseSchema = z.object({
  message: MessageSchema,
  routedTo: z.array(AgentIdSchema),
  command: CommandResultSchema.nullable(),
  /** Attachment problems the person should know about (a document that could not be saved to an agent's workspace). */
  notices: z.array(z.string()).optional(),
})
/** `GET /api/agents/:agentId/context` (PLAN 5.25): the agent's latest run usage and its model's context window. */
export const AgentContextSchema = z.object({
  model: z.string().nullable(),
  tokens: z.object({ input: z.int().nonnegative(), output: z.int().nonnegative() }).nullable(),
  costUsd: z.number().nonnegative().nullable(),
  contextLength: z.int().positive().nullable(),
})
export type AgentContext = z.infer<typeof AgentContextSchema>
/** `POST /api/rooms/:roomId/messages/:messageId/retry` (202): the new placeholder reply. */
export const RetryReplyResponseSchema = z.object({ messageId: z.string().min(1) })
export type RetryReplyResponse = z.infer<typeof RetryReplyResponseSchema>

// §8 Team: SOUL.md / AGENTS.md
export const AgentFileSchema = z.object({
  content: z.string(),
  etag: z.string().regex(/^[a-f0-9]{64}$/),
})
export const AgentFilePreviewSchema = z.object({ diff: z.string() })
export const AgentFileWriteSchema = AgentFileSchema.pick({ etag: true })
/** `details` of a 409 `conflict` on PUT: the current etag and a diff from the current file to the submitted one. */
export const AgentFileConflictSchema = z.object({
  etag: AgentFileSchema.shape.etag,
  diff: z.string(),
})

// §8 Team: routines (not on the stream; refetch after mutations)
export const RoutinesResponseSchema = z.object({ items: z.array(RoutineSummarySchema) })
export const RoutineDeletedSchema = z.object({ id: z.string().min(1) })
/** Run-now only marks the job due; it runs on the scheduler's next tick. */
export const RoutineRunSchema = z.object({ id: z.string().min(1), queued: z.literal(true) })

// §4 Now
export const NowSnapshotSchema = z.object({
  asOfSeq: AsOfSeqSchema,
  now: z.iso.datetime(),
  /** Pause everyone is on (POST /api/team/pause). */
  paused: z.boolean(),
  headline: z.object({
    working: z.int().nonnegative(),
    needsYou: z.int().nonnegative(),
    text: z.string(),
  }),
  lanes: z.array(z.object({ agent: AgentSummarySchema, blocks: z.array(LaneBlockSchema) })),
  handoffs: z.array(HandoffSchema),
  /**
   * Kanban attempts whose claiming profile is unknown (5.17a-1; present only with attempts enabled). Handoffs from
   * or to these blocks carry `agentId: null`.
   */
  unattributed: z.object({ blocks: z.array(LaneBlockSchema) }).optional(),
  focusApproval: ApprovalSchema.nullable(),
  thread: z.object({ roomId: z.string().min(1), messages: z.array(MessageSchema) }).nullable(),
  madeToday: z.array(
    z.object({
      title: z.string(),
      ref: RefSchema,
      files: z.array(
        z.object({
          path: z.string(),
          added: z.int().nonnegative(),
          removed: z.int().nonnegative(),
        }),
      ),
      checks: z.array(
        z.object({
          label: z.string(),
          agentId: AgentIdSchema,
          /** `unknown` = Score has no exact evidence either way (never shown as passed). */
          verdict: z.enum(['passed', 'changes_requested', 'unknown']),
        }),
      ),
    }),
  ),
})
export type NowSnapshot = z.infer<typeof NowSnapshotSchema>

// §9 Reports (not on the stream; refetch)
export const ReportRangeSchema = z.enum(['today', '7d', '30d', 'custom'])
export type ReportRange = z.infer<typeof ReportRangeSchema>
export const ReportsSchema = z.object({
  range: ReportRangeSchema,
  summary: z.string(),
  totals: z.object({
    tasksFinished: z.int().nonnegative(),
    runs: z.int().nonnegative(),
    firstPassRate: z.number().min(0).max(1).nullable(),
    medianTaskSec: z.number().nonnegative().nullable(),
    spendUsd: z.number().nonnegative().nullable(),
    /** True when `spendUsd` includes a coding agent's API-price equivalent (a subscription is not billed per token). */
    spendEstimated: z.boolean().optional(),
    /** Coding agents whose CLI gave no cost in the window: left out of `spendUsd` (never counted as zero). */
    spendExcluded: z.array(AgentIdSchema).optional(),
    /** Cached share of prompt tokens over the agents that report cache tokens; null when none does. */
    cacheHitRate: z.number().min(0).max(1).nullable().default(null),
  }),
  byDay: z.array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      perAgent: z.record(AgentIdSchema, z.int().nonnegative()),
    }),
  ),
  timeSplit: z.array(
    z.object({
      agentId: AgentIdSchema,
      workingPct: z.number().min(0).max(100),
      waitingOnYouPct: z.number().min(0).max(100),
      waitingOnAgentPct: z.number().min(0).max(100),
    }),
  ),
  byAgent: z.array(
    z.object({
      agentId: AgentIdSchema,
      finished: z.int().nonnegative(),
      runs: z.int().nonnegative(),
      medianSec: z.number().nonnegative().nullable(),
      firstPassRate: z.number().min(0).max(1).nullable(),
      spendUsd: z.number().nonnegative().nullable(),
      /** Absent = `reported` (Hermes). `estimated` = coding agent API-price equivalent; `unknown` = no cost given. */
      spendBasis: CostKindSchema.optional(),
      runtime: RuntimeSchema.optional(),
      cacheHitRate: z.number().min(0).max(1).nullable().default(null),
    }),
  ),
  /** The last 30 local days, oldest first, whatever the range is (5.29). */
  trend: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        runs: z.int().nonnegative(),
        /** null = unknown (Score had no cost readings for that day, or Hermes has no cost). */
        spendUsd: z.number().nonnegative().nullable(),
      }),
    )
    .default([]),
  approvals: z.object({
    asked: z.int().nonnegative(),
    approved: z.int().nonnegative(),
    denied: z.int().nonnegative(),
    medianWaitSec: z.number().nonnegative().nullable(),
    insight: z.string().nullable(),
  }),
  /**
   * Kanban attempts without a known agent (5.17a-1; present only with attempts enabled). Counted here, never in
   * `totals.runs`, `byAgent`, `trend` or session spend. `workingSec` counts proven attempts only.
   */
  unattributed: z
    .object({ runs: z.int().nonnegative(), workingSec: z.int().nonnegative() })
    .optional(),
})
export type Reports = z.infer<typeof ReportsSchema>

// §9 Journey (7.4c): marks per agent over time. Read-only; no memory contents, skills by name only.
export const JourneyKindSchema = z.enum([
  'task_done',
  'note_written',
  'skill_changed',
  'memory_changed',
])
export type JourneyKind = z.infer<typeof JourneyKindSchema>
export const JourneyEventSchema = z.object({
  at: z.iso.datetime(),
  kind: JourneyKindSchema,
  /** Task title, note title, skill name, or "Memory file changed". Never memory contents. */
  label: z.string().max(200),
  /** Task id, note path, or null (skills and memory have nothing to open). */
  ref: z.string().max(512).nullable(),
})
export type JourneyEvent = z.infer<typeof JourneyEventSchema>
export const JOURNEY_MAX_EVENTS = 2000
export const JOURNEY_MAX_EVENTS_PER_AGENT = 500
export const JourneySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** True when a bound (500 per agent, 2,000 in all) dropped older events. */
  truncated: z.boolean(),
  agents: z.array(z.object({ id: AgentIdSchema, events: z.array(JourneyEventSchema) })),
})
export type Journey = z.infer<typeof JourneySchema>

// §10 Display currency (5.29): the person's own manual rate, rate = units of `code` per 1 USD.
export const DisplayCurrencySchema = z.object({
  code: z.string().regex(/^[A-Z]{3}$/),
  rate: z.number().positive().max(1e9),
})
export type DisplayCurrency = z.infer<typeof DisplayCurrencySchema>

// §3 Remote access: paired browsers (management ids never authenticate anything)
export const PairedBrowserSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  address: z.string(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  current: z.boolean(),
})
export const PairedBrowsersSchema = z.object({ items: z.array(PairedBrowserSchema) })
/** "Pair another device": a one-time link for a new browser (contract §3). */
export const PairingLinkSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  expiresAt: z.iso.datetime(),
})
export type PairingLink = z.infer<typeof PairingLinkSchema>
/** Whether the security password that guards pairing management is set (contract §3). */
export const SecurityStatusSchema = z.object({
  passwordSet: z.boolean(),
  /** Origins a pairing link may use (SCORE_PUBLIC_ORIGINS); the first is the default. */
  origins: z.array(z.url({ protocol: /^https?$/ })).default([]),
  /** The web terminal is enabled on this server (SCORE_TERMINAL=1, PLAN 7.3). */
  terminal: z.boolean().default(false),
  /** Why SCORE_TERMINAL=1 is not in effect (e.g. 'node-pty not built'); null otherwise. */
  terminalUnavailable: z.string().nullable().default(null),
})
export const RevokeOthersResponseSchema = z.object({ revoked: z.int().nonnegative() })
export type PairedBrowser = z.infer<typeof PairedBrowserSchema>

// §3 Passkeys (5.28): WebAuthn credentials that sign a browser in without a pairing link.
export const PasskeySchema = z.object({
  /** The credential id (base64url): a management handle, not a secret. */
  id: z.string().min(1).max(1400),
  label: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  /** A sign-count regression was seen (possible cloned authenticator): the credential no longer signs in. */
  flagged: z.boolean(),
})
export const PasskeysSchema = z.object({
  /** Whether this origin can use passkeys at all: they need a domain name (or localhost), never an IP address. */
  available: z.boolean(),
  rpId: z.string().nullable(),
  items: z.array(PasskeySchema),
})
/** Options and responses are the WebAuthn JSON forms; the server validates them with @simplewebauthn/server. */
export const PasskeyCeremonySchema = z.record(z.string(), z.unknown())
export type Passkey = z.infer<typeof PasskeySchema>
export type Passkeys = z.infer<typeof PasskeysSchema>

// §3 Score's own log (5.29): newest first, every field redacted before it leaves the server.
export const LogLevelSchema = z.enum(['info', 'warn', 'error'])
export const LogEntrySchema = z.object({
  time: z.iso.datetime().nullable(),
  level: LogLevelSchema,
  message: z.string(),
  method: z.string().nullable(),
  url: z.string().nullable(),
  status: z.int().nullable(),
  durationMs: z.number().nullable(),
})
export const LogsResponseSchema = z.object({
  /** False when `SCORE_LOG_FILE` is not set (dev, tests): the server then has no file to read. */
  available: z.boolean(),
  items: z.array(LogEntrySchema),
})
export type LogEntry = z.infer<typeof LogEntrySchema>
export type LogsResponse = z.infer<typeof LogsResponseSchema>
