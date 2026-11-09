import type { VoteView } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { openPolicyGate } from './advisor.ts'
import { touch, type Ctx } from './ctx.ts'
import {
  helpersOf,
  helperStepsUsed,
  insertHelperStep,
  nextHelper,
  votersOf,
  type HelpersConfig,
} from './helpers-config.ts'
import { addStored, cascadeBlocked, setStepStatus, utf8Bytes, withdrawGates } from './ops.ts'
import { addCause, addHistory, stepsOf, type OrchRow, type StepRow } from './store.ts'

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
  /** 3.14: the lead's step this automatic vote judges (it waits for the tally). */
  step_id: z.string().nullable().optional(),
})
type VoteRow = z.infer<typeof VoteRowSchema>

function votesOf(sqlite: DatabaseSync, orchId: string): VoteRow[] {
  return z
    .array(VoteRowSchema)
    .parse(
      sqlite
        .prepare('SELECT * FROM orc_votes WHERE orchestration_id = ? ORDER BY created_at, rowid')
        .all(orchId),
    )
}

/** A clear majority: at least this share of the usable answers, from at least half of the voters. */
const SHARP_SHARE = 0.7

/** The automatic vote's answers, in order: the first lets the step go ahead. */
export const STEP_VOTE_OPTIONS = [
  'Yes, go ahead',
  'No: another agent should do it',
  'No: the approach is wrong',
] as const

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
  if (vote.step_id) return tallyStepVote(ctx, o, helpers, vote, counts, status, top, share)
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
  vote: { question: string; options: string[]; k: number; createdIn: string; stepId?: string },
): string {
  const { sqlite, now } = ctx
  const id = `v${votesOf(sqlite, o.id).length + 1}`
  sqlite
    .prepare(
      `INSERT INTO orc_votes (orchestration_id, id, question, options, k, status, created_in_attempt, created_at, step_id) VALUES (?, ?, ?, ?, ?, 'voting', ?, ?, ?)`,
    )
    .run(
      o.id,
      id,
      vote.question,
      JSON.stringify(vote.options),
      vote.k,
      vote.createdIn,
      now,
      vote.stepId ?? null,
    )
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

function voteViews(sqlite: DatabaseSync, orchId: string): VoteView[] {
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
    stepId: row.step_id ?? null,
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
    helpers.agentIds.length === 0
      ? `Voters: ${votersOf(helpers).join(', ')}. Ask them when a decision is close; Score counts the answers.`
      : `Helpers: ${helpers.agentIds.join(', ')} (up to ${helpers.maxConcurrent} at once; ${helperStepsUsed(sqlite, o.id)}${helpers.maxSteps === null ? '' : ` of ${helpers.maxSteps}`} helper steps used, outside your step limit). Hand them narrow read-only work with orch.assign(agent, instruction, role) where role is search, grep or audit. Ask ${helpers.voterIds.length > 0 ? `the voters (${helpers.voterIds.join(', ')})` : 'them'} a multiple-choice question with orch.vote(question, options, k): a clear majority (70% or more) comes back as sharp; a split ${helpers.splitTo === 'person' ? 'goes to the person' : 'comes back to you to decide'}.`,
  ]
  const unvoted = (
    sqlite
      .prepare(
        "SELECT count(*) AS n FROM orc_history WHERE orchestration_id = ? AND kind = 'auto_vote_skipped'",
      )
      .get(o.id) as { n: number }
  ).n
  if (helpers.autoVote && unvoted > 0)
    lines.push(
      `${unvoted} of your steps went ahead without a vote (the voters were unavailable, or the helpers' allowance or the budget was used up).`,
    )
  if (helpers.autoVote)
    lines.push(
      `Score asks the voters about each step you assign before it starts ("Is this the right agent and approach?"): a step they reject doesn't start and you're told; one they split on ${helpers.splitTo === 'person' ? 'waits for the person' : 'goes ahead as you chose'}.`,
    )
  if (helpers.autoAudit)
    lines.push(
      'Score has a helper audit each of your steps that succeeds; the audit arrives as its own result (role=audit).',
    )
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

function tallyStepVote(
  ctx: Ctx,
  o: OrchRow,
  helpers: HelpersConfig,
  vote: VoteRow,
  counts: number[],
  status: VoteRow['status'],
  top: number,
  share: number | null,
): void {
  const { sqlite, now } = ctx
  const stepId = vote.step_id!
  const step = stepsOf(sqlite, o.id).find((row) => row.id === stepId)
  const shares = counts.map((n, i) => `${i + 1}=${n}`).join(' ')
  // Go or no-go: both "no" answers count together; the commoner one names the reason (review).
  const usable = counts.reduce((sum, n) => sum + n, 0)
  const no = (counts[1] ?? 0) + (counts[2] ?? 0)
  const enough = usable * 2 >= vote.k
  status =
    usable === 0
      ? 'failed'
      : enough && no / usable >= SHARP_SHARE
        ? 'sharp'
        : enough && (counts[0] ?? 0) / usable >= SHARP_SHARE
          ? 'sharp'
          : 'split'
  top =
    status === 'sharp' && no / usable >= SHARP_SHARE
      ? (counts[2] ?? 0) > (counts[1] ?? 0)
        ? 2
        : 1
      : 0
  share =
    usable === 0 ? null : status === 'sharp' && top > 0 ? no / usable : (counts[0] ?? 0) / usable
  let detail: string
  let gateNeeded = false
  if (status === 'sharp' && top > 0) {
    // The voters agree it's wrong: the step doesn't start; the lead reassigns or rethinks.
    if (step && step.status === 'queued') {
      setStepStatus(sqlite, o.id, stepId, 'rejected', `vote: ${STEP_VOTE_OPTIONS[top]}`, now)
      sqlite
        .prepare('UPDATE orc_steps SET retired = 1 WHERE orchestration_id = ? AND id = ?')
        .run(o.id, stepId)
      withdrawGates(sqlite, o.id, now, stepId)
      cascadeBlocked(sqlite, o.id, now)
    }
    detail = `${stepId} not started: the voters said "${STEP_VOTE_OPTIONS[top]}" (${share!.toFixed(2)}). Reassign it or change the approach.`
  } else if (status === 'split' && helpers.splitTo === 'person' && step?.status === 'queued') {
    gateNeeded = true
    detail = `${stepId} split the voters (${shares}); the person decides whether it starts.`
  } else
    detail =
      status === 'sharp'
        ? `${stepId} goes ahead: the voters agreed (${share!.toFixed(2)}).`
        : `${stepId} goes ahead as you chose; the voters ${status === 'failed' ? 'gave no usable answer' : `split (${shares})`}.`
  if (gateNeeded && step) {
    sqlite
      .prepare(
        "UPDATE orc_steps SET status = 'pending_gate', updated_at = ? WHERE orchestration_id = ? AND id = ?",
      )
      .run(now, o.id, stepId)
    openPolicyGate(sqlite, o, stepId, step.agent_id, step.instruction, now, step.after_steps)
  }
  sqlite
    .prepare(
      'UPDATE orc_votes SET status = ?, counts = ?, choice = ?, share = ?, tallied_at = ? WHERE orchestration_id = ? AND id = ?',
    )
    .run(status, JSON.stringify(counts), status === 'sharp' ? top : null, share, now, o.id, vote.id)
  addHistory(sqlite, o.id, 'vote_tallied', { voteId: vote.id, stepId, status, counts }, now)
  addCause(sqlite, o.id, 'vote_done', vote.id, now, detail)
  touch(ctx, o.id)
}
