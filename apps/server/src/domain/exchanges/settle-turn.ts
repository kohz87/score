import { recordComments } from './review-comments.ts'
import type { DatabaseSync } from 'node:sqlite'
import { ExchangeActionSchema, type ExchangeAction, type MessagePart } from '@score/contract'
import { z } from 'zod'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import type { MessageRun } from '../message-runs.ts'
import { parseMessage } from '../parse.ts'
import { actionGroup, redactSettledActions, roomMembers, stageAction, turnById } from './actions.ts'
import { parseScoreAction } from './action-block.ts'
import { answerExchange, route } from './exchange-answers.ts'
import { makeGive } from './give.ts'
import { jobState } from './job-state.ts'
import { leadDecision } from './lead-decision.ts'
import { exchangeRow, updateJob } from './store.ts'
import { hold } from './budget.ts'

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

interface Settled {
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
  // `actions` is read above, so redacting the stored copy as the turn settles can't change what gets applied.
  const settle = (state: 'applied' | 'dropped') => {
    sqlite
      .prepare("UPDATE exchange_actions SET state = ? WHERE turn_id = ? AND state = 'staged'")
      .run(state, mapping.turn_id)
    redactSettledActions(sqlite, mapping.turn_id)
  }
  const give = makeGive(sqlite, { ...mapping, agentId: me, messageId, jobId }, drafts, now)

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

  // A turn the person stopped (or one in an exchange they stopped) routes nothing, even if it completed first.
  const stopped = mapping.stop_requested_at != null || exchange?.state === 'stopped'
  if (status !== 'completed' || stopped) {
    settle('dropped')
    const why = stopped || status === 'cancelled' || status === 'stopped' ? 'was stopped' : 'failed'
    for (const { args } of actions.filter(({ args }) => actionGroup(args.action) === 'routing'))
      notices.push({
        kind: 'notice',
        code: 'action_not_sent',
        text: `${me}'s ${describe(args, exchange?.from_agent_id ?? null)} was not sent: the turn ${why}.`,
      })
    // Whoever waits on this turn now waits on the person, from either side: try again, give it to someone else, stop.
    if (!stopped && exchange && !['done', 'stopped'].includes(exchange.state))
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
            exchangeId: exchange.id,
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
  let routed: string | null = null
  if (routing?.action === 'handoff' || routing?.action === 'ask' || routing?.action === 'review') {
    const sent = route(
      sqlite,
      { me, jobId, turnId: mapping.turn_id, exchange: current },
      routing,
      give,
      now,
    )
    drafts.push(...sent.drafts)
    routed = sent.exchangeId
  }
  // Line notes (11.6a): a verdict's notes belong to the review it answered — only when step 1 applied it (a live
  // review opened to this agent); a review request's to the exchange it opened or reopened.
  const where = { jobId, turnId: mapping.turn_id, agentId: me }
  if (
    (routing?.action === 'approve' || routing?.action === 'send_back') &&
    exchange?.kind === 'review' &&
    exchange.to_agent_id === me &&
    exchange.state === 'live'
  )
    recordComments(sqlite, { ...where, exchangeId: exchange.id }, routing, now)
  if (routing?.action === 'review' && routed)
    recordComments(sqlite, { ...where, exchangeId: routed }, routing, now)
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
