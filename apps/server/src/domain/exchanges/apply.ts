import type { DatabaseSync } from 'node:sqlite'
import { ExchangeActionSchema, type ExchangeAction, type MessagePart } from '@score/contract'
import { z } from 'zod'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { redact, redactBounded } from '../../redact.ts'
import { agentAdmits } from '../agent-lifecycle.ts'
import type { MessageRun } from '../message-runs.ts'
import { reserveMessageRun } from '../message-runs.ts'
import { parseMessage } from '../parse.ts'
import { isRouting, roomMembers, stageAction, turnById } from './actions.ts'
import { parseScoreAction } from './action-block.ts'
import {
  exchangeEvent,
  exchangeRow,
  openExchange,
  updateExchange,
  updateJob,
  type ExchangeRow,
} from './store.ts'

// What happens when a turn in a room with `routing = exchanges` ends (docs/briefs/11.0-bold.md §4.3–§4.4): its staged
// actions are applied only if it completed, in the transaction that completes it; the answer to a question and the
// outcome of a review go back to whoever asked; a prose @mention hands nothing off.

const QUOTE_BYTES = 4000
/** Agent text handed to another agent is quoted and labelled: data for that agent, never instructions with authority. */
const quote = (who: string, text: string) =>
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
  }
}

export interface Settled {
  drafts: DomainEventDraft[]
  /** Lines Score adds to the agent's message (a dropped action, an ignored block, a mention that handed nothing off). */
  notices: Extract<MessagePart, { kind: 'notice' }>[]
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

  if (status !== 'completed') {
    settle('dropped')
    const why = status === 'cancelled' || status === 'stopped' ? 'was stopped' : 'failed'
    for (const { args } of actions.filter(({ args }) => isRouting(args.action)))
      notices.push({
        kind: 'notice',
        code: 'action_not_sent',
        text: `${me}'s ${describe(args, exchange?.from_agent_id ?? null)} was not sent: the turn ${why}.`,
      })
    // Whoever waits on this turn now waits on the person (11.1c turns this into a card with options).
    if (exchange && exchange.to_agent_id === me && !['done', 'stopped'].includes(exchange.state))
      drafts.push(
        ...updateExchange(
          sqlite,
          exchange.id,
          { state: 'waiting_on_you', ended_reason: `${me}'s turn ${why}` },
          now,
        ),
      )
    drafts.push(...updateJob(sqlite, jobId, { state: jobState(sqlite, jobId) }, now))
    return { drafts, notices }
  }

  const routing = actions.find(({ args }) => isRouting(args.action))?.args
  const marked = actions.find(({ args }) => args.action === 'reply')?.args
  const give = (agentId: string, input: string, exchangeId: string | null) => {
    if (!agentAdmits(sqlite, agentId)) return
    reserveMessageRun(
      sqlite,
      {
        parentMessageId: messageId,
        roomId: mapping.room_id,
        agentId,
        chainId: mapping.chain_id,
        hop: mapping.hop + 1,
        input,
        agents: mapping.agents,
        fromAgentId: me,
        exchangeId,
      },
      now,
    )
  }

  // 1. The exchange this turn worked in, from the side of whoever it was opened to.
  if (exchange && exchange.to_agent_id === me && ['live', 'paused_budget'].includes(exchange.state))
    drafts.push(...answerExchange(sqlite, exchange, routing, marked, reply, give, now))
  else if (
    exchange?.kind === 'review' &&
    exchange.from_agent_id === me &&
    exchange.state === 'waiting_on_agent' &&
    !(routing?.action === 'review' && routing.to === exchange.to_agent_id)
  )
    drafts.push(
      ...updateExchange(
        sqlite,
        exchange.id,
        { state: 'waiting_on_you', ended_reason: `${me} didn't send it back for review` },
        now,
      ),
    )

  // 2. The routing action, unless it was the verdict handled above.
  if (routing?.action === 'handoff' || routing?.action === 'ask' || routing?.action === 'review')
    drafts.push(
      ...route(sqlite, { me, jobId, turnId: mapping.turn_id, exchange }, routing, give, now),
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
  drafts.push(...updateJob(sqlite, jobId, { state: jobState(sqlite, jobId) }, now))
  return { drafts, notices }
}

/** `working` while any other turn of the job is queued or running; otherwise the job waits on the person. */
function jobState(sqlite: DatabaseSync, jobId: string): 'working' | 'waiting_on_you' {
  // The turn being settled is still `active` until completeRunMessage marks it completed.
  const open = sqlite
    .prepare(
      `SELECT count(*) AS n FROM message_runs WHERE job_id = ? AND state IN ('pending', 'active')`,
    )
    .get(jobId) as { n: number }
  return open.n > 1 ? 'working' : 'waiting_on_you'
}

type Give = (agentId: string, input: string, exchangeId: string | null) => void

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
      const drafts = updateExchange(
        sqlite,
        exchange.id,
        { state: 'done', outcome: 'answered' },
        now,
      )
      const parent = exchange.parent_id ? exchangeRow(sqlite, exchange.parent_id) : null
      if (parent?.state === 'waiting_on_agent')
        drafts.push(...updateExchange(sqlite, parent.id, { state: 'live' }, now))
      give(author, `${me} answered your question.\n\n${quote(me, answer)}`, parent?.id ?? null)
      return drafts
    }
    case 'review':
      if (routing?.action === 'approve') {
        give(
          author,
          `${me} approved your work.\n\n${quote(me, routing.note)}\n\nFinish up, or end your turn if nothing is left.`,
          exchange.id,
        )
        return updateExchange(sqlite, exchange.id, { state: 'done', outcome: 'approved' }, now)
      }
      if (routing?.action === 'send_back') {
        const round = exchange.round + 1
        give(
          author,
          `${me} sent your work back (round ${round}).\n\n${quote(me, routing.note)}\n\nFix it, then ask ${me} to review it again (score_review).`,
          exchange.id,
        )
        return updateExchange(sqlite, exchange.id, { state: 'waiting_on_agent', round }, now)
      }
      return updateExchange(
        sqlite,
        exchange.id,
        { state: 'waiting_on_you', outcome: 'no_decision', ended_reason: `${me} didn't decide` },
        now,
      )
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
  const open = (kind: ExchangeRow['kind'], parentId: string | null) =>
    openExchange(sqlite, { jobId, kind, parentId, from: me, to: action.to, turnId }, now)
  switch (action.action) {
    case 'handoff': {
      const id = open('handoff', null)
      drafts.push(...updateJob(sqlite, jobId, { holder: action.to }, now))
      give(action.to, `${me} handed this work to you.\n\n${quote(me, action.note)}`, id)
      drafts.push(...exchangeEvent(sqlite, id))
      break
    }
    case 'ask': {
      const id = open('ask', exchange && exchange.state !== 'done' ? exchange.id : null)
      if (exchange && exchange.state === 'live')
        drafts.push(...updateExchange(sqlite, exchange.id, { state: 'waiting_on_agent' }, now))
      give(
        action.to,
        `${me} asks you a question. Your reply goes back to ${me}.\n\n${quote(me, action.question)}`,
        id,
      )
      drafts.push(...exchangeEvent(sqlite, id))
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
      else drafts.push(...exchangeEvent(sqlite, id))
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
