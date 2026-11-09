import { HELPER_STEPS_UNLIMITED_SIZING } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { lifecycleOf } from '../agent-lifecycle.ts'
import { ADVISOR_STEPS } from './advisor.ts'
import { touch, type Ctx } from './ctx.ts'
import { addStored, utf8Bytes } from './ops.ts'
import { addHistory, stepsOf, type OrchRow, type StepRow } from './store.ts'

const HelpersConfigSchema = z.object({
  agentIds: z.array(z.string()),
  maxConcurrent: z.int().positive(),
  /** null = no separate limit (until the job ends). */
  maxSteps: z.int().positive().nullable(),
  scan: z.boolean(),
  scanFolder: z.string().nullable(),
  splitTo: z.enum(['lead', 'person']),
  /** 3.13.1: who answers votes; empty = the helpers. */
  voterIds: z.array(z.string()).default([]),
  /** 3.14: Score's automatic votes on each of the lead's steps, and audits after each. */
  autoVote: z.boolean().default(false),
  autoVoteK: z.int().min(3).max(7).default(3),
  autoAudit: z.boolean().default(false),
})
export type HelpersConfig = z.infer<typeof HelpersConfigSchema>

export function helpersOf(o: Pick<OrchRow, 'helpers_json'>): HelpersConfig | null {
  return o.helpers_json ? HelpersConfigSchema.parse(JSON.parse(o.helpers_json)) : null
}

/** Helper work and vote answers use the helpers' slots, not the lead's. */
export const usesHelperSlot = (step: Pick<StepRow, 'role'>): boolean =>
  step.role === 'helper' || step.role === 'vote'

const READ_ONLY = 'Read only: change nothing, run nothing that writes.'
export const ROLE_PREAMBLE: Record<'search' | 'grep' | 'audit', string> = {
  search: `You are a search helper. Find where the things asked about below are. Reply with a compact list, one per line: path (with line numbers where useful) and a few words. ${READ_ONLY}`,
  grep: `You are a grep helper. Find every place the thing asked about below occurs or is called. Reply one per line as path:line followed by the line. ${READ_ONLY}`,
  audit: `You are an audit helper. Check the change described below for bugs, missing tests and risky edits. Reply with findings, most severe first, each with path:line and one sentence. Say "clean" if you find nothing. ${READ_ONLY}`,
}

const SCAN_PARTS = [
  {
    role: 'scan_stack',
    ask: 'What is the stack (languages, frameworks, package managers and their versions) and how is it laid out? Name the manifests you read.',
  },
  {
    role: 'scan_scripts',
    ask: 'Which commands build, test, lint and run it (package scripts, make targets, CI files)? Give the exact commands.',
  },
  {
    role: 'scan_risks',
    ask: 'Which paths are risky to change (migrations, generated or vendored code, secrets, lockfiles, deployment files), and why?',
  },
] as const

export function helperStepsUsed(sqlite: DatabaseSync, orchId: string): number {
  return stepsOf(sqlite, orchId).filter(usesHelperSlot).length
}

/** Who answers votes: the voters the person named, else the helpers. */
export const votersOf = (helpers: HelpersConfig): string[] =>
  helpers.voterIds.length > 0 ? helpers.voterIds : helpers.agentIds

/** The agent the next piece of work goes to: the one with the fewest steps so far (ties: listed order). */
export function nextHelper(
  sqlite: DatabaseSync,
  orchId: string,
  helpers: HelpersConfig,
  pool: readonly string[] = helpers.agentIds,
): string {
  const used = new Map<string, number>()
  for (const step of stepsOf(sqlite, orchId).filter(usesHelperSlot))
    used.set(step.agent_id, (used.get(step.agent_id) ?? 0) + 1)
  return pool.reduce((best, id) => ((used.get(id) ?? 0) < (used.get(best) ?? 0) ? id : best))
}

/** Inserts one helper or vote step (queued, or pending its gate when `gated`). Returns its id. */
export function insertHelperStep(
  ctx: Ctx,
  o: OrchRow,
  step: {
    agentId: string
    instruction: string
    role: 'helper' | 'vote'
    helperRole: string | null
    voteId?: string
    createdIn: string
    status: 'queued' | 'pending_gate'
  },
): string {
  const { sqlite, now } = ctx
  const n = helperStepsUsed(sqlite, o.id) + 1
  const id = `h${n}`
  sqlite
    .prepare(
      `INSERT INTO orc_steps (orchestration_id, id, seq, agent_id, agent_incarnation, instruction, after_steps, replaces, status, estimate_usd, created_in_attempt, created_at, updated_at, role, helper_role, vote_id)
       VALUES (?, ?, ?, ?, ?, ?, '[]', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.id,
      id,
      o.steps_created + 500 + n,
      step.agentId,
      lifecycleOf(sqlite, step.agentId)?.incarnation_id ?? 'untracked',
      step.instruction,
      step.status,
      o.step_estimate_usd,
      step.createdIn,
      now,
      now,
      step.role,
      step.helperRole,
      step.voteId ?? null,
    )
  addStored(sqlite, o.id, utf8Bytes(step.instruction) + 256)
  touch(ctx, o.id)
  return id
}

/** At creation: the scan's three parts go to the helpers before the lead's first turn (no gate: the person asked). */
export function startScan(ctx: Ctx, o: OrchRow, folder: string): void {
  const helpers = helpersOf(o)!
  for (const part of SCAN_PARTS.slice(0, helpers.maxSteps ?? SCAN_PARTS.length))
    insertHelperStep(ctx, o, {
      agentId: nextHelper(ctx.sqlite, o.id, helpers),
      instruction: `You are a scan helper. Read the project in the folder ${folder} and answer, in at most 1,500 characters: ${part.ask} ${READ_ONLY}`,
      role: 'helper',
      helperRole: part.role,
      createdIn: 'score',
      status: 'queued',
    })
  addHistory(ctx.sqlite, o.id, 'scan_started', { folder }, ctx.now)
}

/** Every step a run may hold and run at once: the lead's, its helpers' and the advisor's consults (sizes the reserves). */
export function effectiveSize(o: OrchRow): { steps: number; concurrent: number } {
  const helpers = helpersOf(o)
  return {
    steps:
      o.max_steps +
      (helpers ? (helpers.maxSteps ?? HELPER_STEPS_UNLIMITED_SIZING) : 0) +
      (o.advisor_agent_id ? ADVISOR_STEPS : 0),
    concurrent: o.max_concurrent_steps + (helpers?.maxConcurrent ?? 0),
  }
}

/** Helper steps left before the allowance is used up; Infinity with no limit. */
export function helperStepsLeft(
  sqlite: DatabaseSync,
  orchId: string,
  helpers: HelpersConfig,
): number {
  return helpers.maxSteps === null ? Infinity : helpers.maxSteps - helperStepsUsed(sqlite, orchId)
}
