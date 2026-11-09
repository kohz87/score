import type { JobSubagentsRequest } from '@score/contract'

/** 3.23.0: where Start a job starts, when the opener knows (a chat's own button, `/run`). */
export type StartJobOptions = {
  /** The chat the run starts in; without it, the team room the address names. */
  roomId?: string
  /** `/run <name>`: the saved recipe to preselect (case-insensitive). */
  recipeName?: string
  /** 3.28.0: ask which chat it starts in ("Start in another chat…" from the busy dialog). */
  pickChat?: boolean
  /** The chat the person is leaving (it has a job running); the picker doesn't list it. */
  exceptRoomId?: string
}

export type RecipeChoice =
  { kind: 'lead' } | { kind: 'none' } | { kind: 'workflow'; id: string; name: string }

export type Result =
  | { kind: 'job'; title: string; jobId: string; orchestrationId?: string }
  | { kind: 'workflow'; title: string; runId: string; jobId?: string }
  | { kind: 'routine'; title: string; schedule: string }
  | { kind: 'trigger'; title: string; url: string | null; secret: string }

export type JobLimits = {
  exchangeBudget?: number
  jobTurnLimit?: number
  spendCapUsd?: number
  /** SA.3: the job's subagents (Start a job's Subagents choice). */
  subagents?: JobSubagentsRequest
}
