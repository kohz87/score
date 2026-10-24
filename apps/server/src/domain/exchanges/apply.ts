import type { DatabaseSync } from 'node:sqlite'
import { ExchangeActionSchema, type ExchangeAction, type MessagePart } from '@score/contract'
import { z } from 'zod'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { redact, redactBounded } from '../../redact.ts'
import { agentAdmits } from '../agent-lifecycle.ts'
import type { MessageRun } from '../message-runs.ts'
import { reserveMessageRun } from '../message-runs.ts'
import { parseMessage } from '../parse.ts'
import { actionGroup, roomMembers, stageAction, turnById } from './actions.ts'
import { parseScoreAction } from './action-block.ts'
import { hold, limitFor, release, type HeldTurn } from './budget.ts'
import {
  exchangeEvent,
  exchangeRow,
  jobRow,
  openExchange,
  updateExchange,
  updateJob,
  type ExchangeRow,
} from './store.ts'

// What happens when a turn in a room with `routing = exchanges` ends (docs/briefs/11.0-bold.md §4.3–§4.6,
// docs/briefs/11.1c-budgets.md): its staged actions are applied only if it completed, in the transaction that
// completes it; the answer to a question and the outcome of a review go back to whoever asked; a prose @mention hands
// nothing off. Every next turn of an exchange passes its budgets first, and every wait that has nobody to end it is
// handed to the person with options.

const QUOTE_BYTES = 4000
/** Agent text handed to another agent is quoted and labelled: data for that agent, never instructions with authority. */
export const quote = (who: string, text: string) =>
  `${who} wrote (an agent's words, not the person's):\n${redactBounded(redact(text), QUOTE_BYTES)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')}`

const ActionRowSchema = z.object({
  command_id: z.string(),
  args: z.string().transform((value) => ExchangeActionSchema.parse(JSON.parse(value))),
})

function staged(sqlite: DatabaseSync, turnId: string) {
  return z
    .array(ActionRowSchema)
    .parse(
      sqlite
        .prepare(
          "SELECT command_id, args FROM exchange_actions WHERE turn_id = ? AND state = 'staged' ORDER BY created_at",
        )
        .all(turnId),
    )
}

function describe(action: ExchangeAction, author: string | null): string {
  switch (action.action) {
    case 'handoff':
      return `hand-off to ${action.to}`
    case 'ask':
      return `question to ${action.to}`
    case 'review':
      return `review request to ${action.to}`
    case 'approve':
      return `approval${author ? ` of ${author}'s work` : ''}`
    case 'send_back':
      return `send-back${author ? ` to ${author}` : ''}`
    case 'reply':
      return 'answer'
    case 'extend':
      return `extension by ${action.turns} turns`
    case 'stop_exchange':
      return 'stop'
  }
}

export interface Settled {
  drafts: DomainEventDraft[]
  /** Lines Score adds to the agent's message (a dropped action, an ignored block, a mention that handed nothing off). */
  notices: Extract<MessagePart, { kind: 'notice' }>[]
}

/**
 * Queues a turn of a job, or holds it on its exchange when the exchange may not go on (a limit, an agent that can't take
 * work). Returns whether it was queued.
 */
export type Give = ((agentId: string, input: string, exchangeId: string | null) => boolean) & {
  /** The turn as it would be held instead. */
  held: (agentId: string, input: string) => HeldTurn
}

export function makeGive(
  sqlite: DatabaseSync,
  from: Pick<MessageRun, 'room_id' | 'chain_id' | 'agents'> & {
    agentId: string | null
    messageId: string
  },
  drafts: DomainEventDraft[],
  now: string,
): Give {
  const heldOf = (agentId: string, input: string): HeldTurn => ({
    agentId,
    input,
    parentMessageId: from.messageId,
    chainId: from.chain_id,
    fromAgentId: from.agentId,
    roomId: from.room_id,
    agents: from.agents,
  })
  const give = (agentId: string, input: string, exchangeId: string | null) => {
    const held = heldOf(agentId, input)
    const exchange = exchangeId ? exchangeRow(sqlite, exchangeId) : null
    const open = exchange && !['done', 'stopped'].includes(exchange.state)
    if (!agentAdmits(sqlite, agentId)) {
      if (open)
        drafts.push(
          ...hold(
            sqlite,
            exchange.id,
            'unreachable',
            held,
            now,
            `${agentId} can't take work right now`,
          ),
        )
      return false
    }
    // A finished exchange's last word (an approval) still goes out; one still going passes its limits first.
    const limit = open ? limitFor(sqlite, exchange.id) : null
    if (open && limit) {
      drafts.push(...hold(sqlite, exchange.id, limit, held, now))
      return false
    }
    reserveMessageRun(
      sqlite,
      {
        parentMessageId: from.messageId,
        roomId: from.room_id,
        agentId,
        chainId: from.chain_id,
        // hop counts @mention hand-offs (D3.2, at most 4); exchanges are bounded by turn budgets instead (§4.5), so
        // a turn an agent starts here is simply "not the person's" (hop > 0).
        hop: 1,
        input,
        agents: from.agents,
        ...(from.agentId ? { fromAgentId: from.agentId } : {}),
        exchangeId,
        // One completion can give the same agent two turns (an answer back and a hand-off): one per exchange.
        retryNonce: exchangeId ?? 'job',
      },
      now,
    )
    return true
  }
  return Object.assign(give, { held: heldOf })
}

/**
 * Settles a turn of an exchanges room. `reply` is the authoritative final reply (the answer to a question when no
 * `reply` action marks one); `coding` reads a `score-action` block from it instead of tool calls.
 */
export function settleExchangeTurn(
  sqlite: DatabaseSync,
  mapping: MessageRun,
  messageId: string,
  { status, reply, coding }: { status: string; reply: string; coding: boolean },
  now: string,
): Settled {
  const drafts: DomainEventDraft[] = []
  const notices: Settled['notices'] = []
  const turn = turnById(sqlite, mapping.turn_id)
  const jobId = mapping.job_id
  // The capability ends with the turn.
  sqlite.prepare('UPDATE message_runs SET xtc_hash = NULL WHERE turn_id = ?').run(mapping.turn_id)
  if (!turn || !jobId) return { drafts, notices }
  const me = mapping.agent_id
  const exchange = mapping.exchange_id ? exchangeRow(sqlite, mapping.exchange_id) : null

  if (coding && status === 'completed') {
    const block = parseScoreAction(reply)
    if (block.kind === 'action') {
      const receipt = stageAction(
        sqlite,
        { turn, commandId: 'block', action: block.action, channel: 'block' },
        now,
      )
      if (receipt.status === 'refused')
        notices.push({
          kind: 'notice',
          code: 'action_ignored',
          text: `Score ignored this reply's action: ${receipt.message}`,
        })
    } else if (block.kind === 'invalid')
      notices.push({ kind: 'notice', code: 'action_ignored', text: block.notice })
  }

  const actions = staged(sqlite, mapping.turn_id)
  const settle = (state: 'applied' | 'dropped') =>
    sqlite
      .prepare("UPDATE exchange_actions SET state = ? WHERE turn_id = ? AND state = 'staged'")
      .run(state, mapping.turn_id)
  const give = makeGive(sqlite, { ...mapping, agentId: me, messageId }, drafts, now)

  // The room lead's turn deciding a budget pause ("Let lead decide").
  const decided = sqlite
    .prepare('SELECT id FROM exchanges WHERE decider_turn_id = ?')
    .get(mapping.turn_id) as { id: string } | undefined
  if (decided) {
    const decision =
      status === 'completed'
        ? actions.find(({ args }) => actionGroup(args.action) === 'decision')?.args
        : undefined
    settle(status === 'completed' ? 'applied' : 'dropped')
    drafts.push(...leadDecision(sqlite, decided.id, me, decision, now))
    drafts.push(
      ...updateJob(sqlite, jobId, { state: jobState(sqlite, jobId, mapping.turn_id) }, now),
    )
    return { drafts, notices }
  }

  if (status !== 'completed') {
    settle('dropped')
    const why = status === 'cancelled' || status === 'stopped' ? 'was stopped' : 'failed'
    for (const { args } of actions.filter(({ args }) => actionGroup(args.action) === 'routing'))
      notices.push({
        kind: 'notice',
        code: 'action_not_sent',
        text: `${me}'s ${describe(args, exchange?.from_agent_id ?? null)} was not sent: the turn ${why}.`,
      })
    // Whoever waits on this turn now waits on the person, from either side: try again, give it to someone else, stop.
    if (exchange && !['done', 'stopped'].includes(exchange.state))
      drafts.push(
        ...hold(
          sqlite,
          exchange.id,
          'turn_failed',
          {
            agentId: me,
            input: mapping.input,
            parentMessageId: mapping.parent_message_id,
            chainId: mapping.chain_id,
            fromAgentId: mapping.from_agent_id,
            roomId: mapping.room_id,
            agents: mapping.agents,
          },
          now,
          `${me}'s turn ${why}`,
        ),
      )
    drafts.push(
      ...updateJob(sqlite, jobId, { state: jobState(sqlite, jobId, mapping.turn_id) }, now),
    )
    return { drafts, notices }
  }

  const routing = actions.find(({ args }) => actionGroup(args.action) === 'routing')?.args
  const marked = actions.find(({ args }) => args.action === 'reply')?.args

  // 1. The exchange this turn worked in, from the side of whoever it was opened to.
  if (exchange && exchange.to_agent_id === me && exchange.state === 'live')
    drafts.push(...answerExchange(sqlite, exchange, routing, marked, reply, give, now))
  else if (
    exchange?.kind === 'review' &&
    exchange.from_agent_id === me &&
    exchange.state === 'waiting_on_agent' &&
    routing?.action !== 'ask' &&
    !(routing?.action === 'review' && routing.to === exchange.to_agent_id)
  )
    drafts.push(
      ...hold(
        sqlite,
        exchange.id,
        'author_stalled',
        null,
        now,
        `${me} didn't send it back for review`,
      ),
    )

  // 2. The routing action, unless it was the verdict handled above; against the exchange as step 1 left it.
  const current = exchange ? exchangeRow(sqlite, exchange.id) : null
  if (routing?.action === 'handoff' || routing?.action === 'ask' || routing?.action === 'review')
    drafts.push(
      ...route(
        sqlite,
        { me, jobId, turnId: mapping.turn_id, exchange: current },
        routing,
        give,
        now,
      ),
    )
  settle('applied')

  // 3. A prose @mention of a teammate hands nothing off in this room: say so, so it isn't mistaken for one.
  if (!routing) {
    const members = roomMembers(sqlite, mapping.room_id).filter((id) => id !== me)
    const mentioned = parseMessage(reply, members).mentions.filter((id) => members.includes(id))
    if (mentioned.length)
      notices.push({
        kind: 'notice',
        code: 'mention_not_handoff',
        text: `Mention, not a hand-off: ${mentioned.map((id) => `@${id}`).join(', ')} wasn't asked to do anything.`,
      })
  }
  drafts.push(...updateJob(sqlite, jobId, { state: jobState(sqlite, jobId, mapping.turn_id) }, now))
  return { drafts, notices }
}

/** `working` while any other agent turn of the job is queued or running; otherwise the job waits on the person. */
export function jobState(
  sqlite: DatabaseSync,
  jobId: string,
  settling: string,
): 'working' | 'waiting_on_you' {
  const open = sqlite
    .prepare(
      `SELECT 1 FROM message_runs WHERE job_id = ? AND turn_id != ? AND purpose IS NULL
         AND state IN ('pending', 'active') LIMIT 1`,
    )
    .get(jobId, settling)
  return open ? 'working' : 'waiting_on_you'
}

/** The lead's turn on a budget pause ended: extend once (up to the job's exchange budget), stop, or back to the person. */
function leadDecision(
  sqlite: DatabaseSync,
  exchangeId: string,
  lead: string,
  decision: ExchangeAction | undefined,
  now: string,
): DomainEventDraft[] {
  const exchange = exchangeRow(sqlite, exchangeId)
  if (!exchange || exchange.state !== 'paused_budget') return []
  if (decision?.action === 'extend') {
    const job = jobRow(sqlite, exchange.job_id)!
    const turns = Math.min(decision.turns, job.exchange_budget)
    const drafts = updateExchange(sqlite, exchangeId, { lead_extended: 1 }, now)
    if (exchange.pause_reason === 'job_limit')
      sqlite
        .prepare('UPDATE jobs SET job_turn_limit = job_turn_limit + ? WHERE id = ?')
        .run(turns, exchange.job_id)
    else
      drafts.push(...updateExchange(sqlite, exchangeId, { budget: exchange.budget + turns }, now))
    return [...drafts, ...release(sqlite, exchangeId, now)]
  }
  if (decision?.action === 'stop_exchange')
    return stopExchanges(sqlite, [exchangeId], `${lead} stopped it`, now).drafts
  // No decision: the pause goes back to the person, and the lead isn't offered again.
  return updateExchange(sqlite, exchangeId, { decider_turn_id: null, lead_extended: 1 }, now)
}

/** Stops exchanges and their open children; their queued turns are failed. Returns the run ids still running. */
export function stopExchanges(
  sqlite: DatabaseSync,
  ids: string[],
  reason: string,
  now: string,
): { drafts: DomainEventDraft[]; running: { agentId: string; runId: string }[] } {
  const drafts: DomainEventDraft[] = []
  const running: { agentId: string; runId: string }[] = []
  const queue = [...ids]
  for (let id = queue.shift(); id; id = queue.shift()) {
    const exchange = exchangeRow(sqlite, id)
    if (!exchange) continue
    for (const child of sqlite
      .prepare("SELECT id FROM exchanges WHERE parent_id = ? AND state NOT IN ('done', 'stopped')")
      .all(id) as { id: string }[])
      queue.push(child.id)
    if (['done', 'stopped'].includes(exchange.state)) continue
    drafts.push(
      ...updateExchange(
        sqlite,
        id,
        {
          state: 'stopped',
          ended_reason: reason,
          pause_reason: null,
          held: null,
          decider_turn_id: null,
        },
        now,
      ),
    )
    for (const turn of sqlite
      .prepare(
        "SELECT turn_id, state, run_id, agent_id FROM message_runs WHERE exchange_id = ? AND state IN ('pending', 'active')",
      )
      .all(id) as { turn_id: string; state: string; run_id: string | null; agent_id: string }[]) {
      if (turn.state === 'active' && turn.run_id)
        running.push({ agentId: turn.agent_id, runId: turn.run_id })
      else
        sqlite
          .prepare(
            "UPDATE message_runs SET state = 'failed' WHERE turn_id = ? AND state = 'pending'",
          )
          .run(turn.turn_id)
    }
  }
  return { drafts, running }
}

/** The turn of the agent an exchange was opened to has ended. */
function answerExchange(
  sqlite: DatabaseSync,
  exchange: ExchangeRow,
  routing: ExchangeAction | undefined,
  marked: ExchangeAction | undefined,
  reply: string,
  give: Give,
  now: string,
): DomainEventDraft[] {
  const me = exchange.to_agent_id
  const author = exchange.from_agent_id
  switch (exchange.kind) {
    case 'handoff':
      return updateExchange(sqlite, exchange.id, { state: 'done', outcome: 'handed_off' }, now)
    case 'ask': {
      // A nested question keeps this one open until its answer comes back.
      if (routing?.action === 'ask') return []
      const answer = marked?.action === 'reply' ? marked.text : reply
      const parent = exchange.parent_id ? exchangeRow(sqlite, exchange.parent_id) : null
      const back = `${me} answered your question.\n\n${quote(me, answer)}`
      // The asker can't take it (retired, being removed): the answer waits for the person (§4.6).
      if (!agentAdmits(sqlite, author))
        return hold(
          sqlite,
          exchange.id,
          'asker_gone',
          give.held(author, back),
          now,
          `${author} can't take the answer right now`,
        )
      const drafts = updateExchange(
        sqlite,
        exchange.id,
        { state: 'done', outcome: 'answered' },
        now,
      )
      // Only an exchange that was waiting on the asker's own turn goes on (a reviewer who asked first).
      if (parent?.state === 'waiting_on_agent' && parent.to_agent_id === author)
        drafts.push(...updateExchange(sqlite, parent.id, { state: 'live' }, now))
      give(author, back, parent?.id ?? null)
      return drafts
    }
    case 'review': {
      // A reviewer's question keeps the review open; its answer comes back to the reviewer.
      if (routing?.action === 'ask') return []
      if (routing?.action === 'approve') {
        const drafts = updateExchange(
          sqlite,
          exchange.id,
          { state: 'done', outcome: 'approved' },
          now,
        )
        give(
          author,
          `${me} approved your work.\n\n${quote(me, routing.note)}\n\nFinish up, or end your turn if nothing is left.`,
          exchange.id,
        )
        return drafts
      }
      if (routing?.action === 'send_back') {
        const round = exchange.round + 1
        const drafts = updateExchange(
          sqlite,
          exchange.id,
          { state: 'waiting_on_agent', round },
          now,
        )
        give(
          author,
          `${me} sent your work back (round ${round}).\n\n${quote(me, routing.note)}\n\nFix it, then ask ${me} to review it again (score_review).`,
          exchange.id,
        )
        return drafts
      }
      return hold(sqlite, exchange.id, 'no_decision', null, now, `${me} didn't decide`)
    }
  }
}

/** Opens the exchange a hand-off, question or review request asks for, and gives its target a turn. */
function route(
  sqlite: DatabaseSync,
  turn: { me: string; jobId: string; turnId: string; exchange: ExchangeRow | null },
  action: Extract<ExchangeAction, { action: 'handoff' | 'ask' | 'review' }>,
  give: Give,
  now: string,
): DomainEventDraft[] {
  const { me, jobId, turnId, exchange } = turn
  const drafts: DomainEventDraft[] = []
  const open = (kind: ExchangeRow['kind'], parentId: string | null) => {
    const id = openExchange(sqlite, { jobId, kind, parentId, from: me, to: action.to, turnId }, now)
    drafts.push(...exchangeEvent(sqlite, id))
    return id
  }
  switch (action.action) {
    case 'handoff': {
      const id = open('handoff', null)
      drafts.push(...updateJob(sqlite, jobId, { holder: action.to }, now))
      give(action.to, `${me} handed this work to you.\n\n${quote(me, action.note)}`, id)
      break
    }
    case 'ask': {
      const waiting = exchange && !['done', 'stopped'].includes(exchange.state) ? exchange : null
      const id = open('ask', waiting?.id ?? null)
      // The exchange whose turn this was now waits on the answer (a reviewer asking before deciding).
      if (waiting?.state === 'live' && waiting.to_agent_id === me)
        drafts.push(...updateExchange(sqlite, waiting.id, { state: 'waiting_on_agent' }, now))
      give(
        action.to,
        `${me} asks you a question. Your reply goes back to ${me}.\n\n${quote(me, action.question)}`,
        id,
      )
      break
    }
    case 'review': {
      const again = sqlite
        .prepare(
          `SELECT id FROM exchanges WHERE job_id = ? AND kind = 'review' AND from_agent_id = ? AND to_agent_id = ?
             AND state = 'waiting_on_agent' ORDER BY created_at DESC LIMIT 1`,
        )
        .get(jobId, me, action.to) as { id: string } | undefined
      const id = again?.id ?? open('review', null)
      if (again) drafts.push(...updateExchange(sqlite, id, { state: 'live' }, now))
      const round = exchangeRow(sqlite, id)!.round
      give(
        action.to,
        `${me} asks you to review their work${round > 1 ? ` (round ${round})` : ''}. End with score_approve or score_send_back.\n\n${quote(me, action.note)}`,
        id,
      )
      break
    }
  }
  return drafts
}
