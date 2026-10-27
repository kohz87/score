// 3.15–3.16 (decision 150): helpers and votes. Helpers are agents the person named for narrow, read-only work: the lead
// hands them steps with a role (search, grep, audit), they can scan the folder before the lead's first turn, and they
// answer the lead's votes. Their steps run in their own slots (`maxConcurrent`) and allowance (`maxSteps`), outside the
// lead's step limit; everything else (gates, budget, admission, stops, recovery) is the ordinary step machinery.

import type { VoteView } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { lifecycleOf } from '../agent-lifecycle.ts'
import { ADVISOR_STEPS } from './advisor.ts'
import { touch, type Ctx } from './ctx.ts'
import { addStored, utf8Bytes } from './ops.ts'
import { addCause, addHistory, stepsOf, type OrchRow, type StepRow } from './store.ts'

export const HelpersConfigSchema = z.object({
  agentIds: z.array(z.string()).min(1),
  maxConcurrent: z.int().positive(),
  maxSteps: z.int().positive(),
  scan: z.boolean(),
  scanFolder: z.string().nullable(),
  splitTo: z.enum(['lead', 'person']),
  /** 3.13.1: who answers votes; empty = the helpers. */
  voterIds: z.array(z.string()).default([]),
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
function nextHelper(
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
  for (const part of SCAN_PARTS.slice(0, helpers.maxSteps))
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

const FINAL = new Set([
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
  'blocked',
  'rejected',
  'not_started',
])

/**
 * Settles what helper work owes the lead (run on every settle): the scan's end starts the lead's first turn, and a vote
 * whose answers have all ended is tallied.
 */
export function settleHelpers(ctx: Ctx, o: OrchRow): void {
  const helpers = helpersOf(o)
  if (!helpers || o.planner !== 'lead') return
  const { sqlite, now } = ctx
  const steps = stepsOf(sqlite, o.id)
  const scan = steps.filter((step) => step.helper_role?.startsWith('scan_'))
  if (
    scan.length > 0 &&
    scan.every((step) => FINAL.has(step.status)) &&
    sqlite
      .prepare("SELECT 1 FROM orc_causes WHERE orchestration_id = ? AND kind = 'started'")
      .get(o.id) === undefined
  ) {
    addCause(sqlite, o.id, 'started', null, now, 'the helpers’ scan is done; its results are below')
    addHistory(sqlite, o.id, 'scan_done', {}, now)
    touch(ctx, o.id)
  }
  for (const vote of votesOf(sqlite, o.id).filter((row) => row.status === 'voting')) {
    const answers = steps.filter((step) => step.vote_id === vote.id)
    if (answers.length === 0 || !answers.every((step) => FINAL.has(step.status))) continue
    tally(ctx, o, helpers, vote, answers)
  }
}

// ---------------------------------------------------------------------------------------------------------- votes

const VoteRowSchema = z.object({
  orchestration_id: z.string(),
  id: z.string(),
  question: z.string(),
  options: z.string(),
  k: z.int(),
  status: z.enum(['voting', 'sharp', 'split', 'failed']),
  counts: z.string(),
  choice: z.int().nullable(),
  share: z.number().nullable(),
  inquiry_id: z.string().nullable(),
  created_in_attempt: z.string(),
  created_at: z.string(),
  tallied_at: z.string().nullable(),
})
type VoteRow = z.infer<typeof VoteRowSchema>

export function votesOf(sqlite: DatabaseSync, orchId: string): VoteRow[] {
  return z
    .array(VoteRowSchema)
    .parse(
      sqlite
        .prepare('SELECT * FROM orc_votes WHERE orchestration_id = ? ORDER BY created_at, rowid')
        .all(orchId),
    )
}

/** A clear majority: at least this share of the usable answers, from at least half of the voters. */
export const SHARP_SHARE = 0.7

/** The option an answer chose (1-based number at its start, or the option's exact text), or null. */
export function readChoice(answer: string, options: readonly string[]): number | null {
  const text = answer.trim()
  // The exact option text first ("Python 3" is an option, not the number 3).
  const exact = options.findIndex((option) => option.trim().toLowerCase() === text.toLowerCase())
  if (exact >= 0) return exact
  // One number, near the start ("2", "Option 2.", "answer: 2"); an answer naming several numbers is unusable.
  const number = /^\D{0,12}?(\d)\b/.exec(text)
  if (number && (text.match(/\d/g) ?? []).length === 1) {
    const index = Number(number[1]) - 1
    if (index >= 0 && index < options.length) return index
  }
  return null
}

function tally(
  ctx: Ctx,
  o: OrchRow,
  helpers: HelpersConfig,
  vote: VoteRow,
  answers: StepRow[],
): void {
  const { sqlite, now } = ctx
  const options = JSON.parse(vote.options) as string[]
  const counts = options.map(() => 0)
  for (const answer of answers) {
    if (answer.status !== 'succeeded' || answer.result === null) continue
    const choice = readChoice(answer.result, options)
    if (choice !== null) counts[choice]!++
  }
  const usable = counts.reduce((sum, n) => sum + n, 0)
  const top = counts.indexOf(Math.max(...counts))
  const share = usable > 0 ? counts[top]! / usable : null
  const status: VoteRow['status'] =
    usable === 0 ? 'failed' : share! >= SHARP_SHARE && usable * 2 >= vote.k ? 'sharp' : 'split'
  let inquiryId: string | null = null
  const shares = counts
    .map((n, i) => `${i + 1}. ${options[i]} ${usable ? (n / usable).toFixed(2) : '0'}`)
    .join(' / ')
  if (status === 'split' && helpers.splitTo === 'person') {
    // The person decides a split: a question on Needs you, answered to the lead as data like any orch.ask.
    inquiryId = `q${(sqlite.prepare('SELECT count(*) AS n FROM orc_inquiries WHERE orchestration_id = ?').get(o.id) as { n: number }).n + 1}`
    const question = `The helpers split on: ${vote.question}\nVotes: ${shares}\nWhich option should the lead take?`
    sqlite
      .prepare(
        `INSERT INTO orc_inquiries (orchestration_id, id, attempt_id, question, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)`,
      )
      .run(o.id, inquiryId, vote.created_in_attempt, question, now)
    addStored(sqlite, o.id, utf8Bytes(question) + 128)
  }
  sqlite
    .prepare(
      'UPDATE orc_votes SET status = ?, counts = ?, choice = ?, share = ?, inquiry_id = ?, tallied_at = ? WHERE orchestration_id = ? AND id = ?',
    )
    .run(
      status,
      JSON.stringify(counts),
      status === 'sharp' ? top : null,
      share,
      inquiryId,
      now,
      o.id,
      vote.id,
    )
  addHistory(sqlite, o.id, 'vote_tallied', { voteId: vote.id, status, counts }, now)
  const detail =
    status === 'sharp'
      ? `sharp: option ${top + 1} (${share!.toFixed(2)})`
      : status === 'failed'
        ? 'no usable answers'
        : `split${inquiryId ? `, asked the person (${inquiryId})` : ', you decide'}: ${counts.map((n, i) => `${i + 1}=${n}`).join(' ')}`
  addCause(sqlite, o.id, 'vote_done', vote.id, now, detail)
  touch(ctx, o.id)
}

/** Starts a vote: k answers spread over the helpers. Returns the vote id. */
export function startVote(
  ctx: Ctx,
  o: OrchRow,
  helpers: HelpersConfig,
  vote: { question: string; options: string[]; k: number; createdIn: string },
): string {
  const { sqlite, now } = ctx
  const id = `v${votesOf(sqlite, o.id).length + 1}`
  sqlite
    .prepare(
      `INSERT INTO orc_votes (orchestration_id, id, question, options, k, status, created_in_attempt, created_at) VALUES (?, ?, ?, ?, ?, 'voting', ?, ?)`,
    )
    .run(o.id, id, vote.question, JSON.stringify(vote.options), vote.k, vote.createdIn, now)
  const instruction = [
    'You are a voting helper. Answer one multiple-choice question for a lead agent. Reply with only the number of your choice, nothing else.',
    '',
    `Question: ${vote.question}`,
    ...vote.options.map((option, index) => `${index + 1}. ${option}`),
  ].join('\n')
  for (let i = 0; i < vote.k; i++)
    insertHelperStep(ctx, o, {
      agentId: nextHelper(sqlite, o.id, helpers, votersOf(helpers)),
      instruction,
      role: 'vote',
      helperRole: null,
      voteId: id,
      createdIn: vote.createdIn,
      status: 'queued',
    })
  addHistory(sqlite, o.id, 'vote_started', { voteId: id, k: vote.k }, now)
  return id
}

export function voteViews(sqlite: DatabaseSync, orchId: string): VoteView[] {
  return votesOf(sqlite, orchId).map((row) => ({
    id: row.id,
    question: row.question,
    options: JSON.parse(row.options) as string[],
    k: row.k,
    status: row.status,
    counts: JSON.parse(row.counts) as number[],
    choice: row.choice,
    share: row.share,
    inquiryId: row.inquiry_id,
    createdAt: row.created_at,
  }))
}

export function helpersView(sqlite: DatabaseSync, o: OrchRow) {
  const helpers = helpersOf(o)
  if (!helpers) return null
  return { ...helpers, used: helperStepsUsed(sqlite, o.id), votes: voteViews(sqlite, o.id) }
}

/** What the lead reads about its helpers and its latest votes. */
export function helperLines(sqlite: DatabaseSync, o: OrchRow): string[] {
  const helpers = helpersOf(o)
  if (!helpers) return []
  const lines = [
    `Helpers: ${helpers.agentIds.join(', ')} (up to ${helpers.maxConcurrent} at once; ${helperStepsUsed(sqlite, o.id)} of ${helpers.maxSteps} helper steps used, outside your step limit). Hand them narrow read-only work with orch.assign(agent, instruction, role) where role is search, grep or audit. Ask ${helpers.voterIds.length > 0 ? `the voters (${helpers.voterIds.join(', ')})` : 'them'} a multiple-choice question with orch.vote(question, options, k): a clear majority (70% or more) comes back as sharp; a split ${helpers.splitTo === 'person' ? 'goes to the person' : 'comes back to you to decide'}.`,
  ]
  for (const vote of votesOf(sqlite, o.id).slice(-5)) {
    const options = JSON.parse(vote.options) as string[]
    const counts = JSON.parse(vote.counts) as number[]
    lines.push(
      vote.status === 'voting'
        ? `- Vote ${vote.id} (${vote.question.slice(0, 120)}): voting.`
        : `- Vote ${vote.id} (${vote.question.slice(0, 120)}): ${vote.status}${vote.choice !== null ? ` → ${vote.choice + 1}. ${options[vote.choice]}` : ''} [${counts.map((n, i) => `${i + 1}=${n}`).join(' ')}]${vote.inquiry_id ? `, asked the person (${vote.inquiry_id})` : ''}.`,
    )
  }
  return lines
}

/** Every step a run may hold and run at once: the lead's, its helpers' and the advisor's consults (sizes the reserves). */
export function effectiveSize(o: OrchRow): { steps: number; concurrent: number } {
  const helpers = helpersOf(o)
  return {
    steps: o.max_steps + (helpers?.maxSteps ?? 0) + (o.advisor_agent_id ? ADVISOR_STEPS : 0),
    concurrent: o.max_concurrent_steps + (helpers?.maxConcurrent ?? 0),
  }
}
