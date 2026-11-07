import type { DatabaseSync } from 'node:sqlite'
import type { ExchangeAction } from '@score/contract'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { agentAdmits } from '../agent-lifecycle.ts'
import { quote } from './agent-quote.ts'
import { hold } from './budget.ts'
import type { Give } from './give.ts'
import {
  exchangeEvent,
  exchangeRow,
  openExchange,
  updateExchange,
  updateJob,
  type ExchangeRow,
} from './store.ts'

/** The turn of the agent an exchange was opened to has ended. */
export function answerExchange(
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
          give.held(author, back, parent?.id ?? null),
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
      give(author, back, parent?.id ?? null, exchange.id)
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
export function route(
  sqlite: DatabaseSync,
  turn: { me: string; jobId: string; turnId: string; exchange: ExchangeRow | null },
  action: Extract<ExchangeAction, { action: 'handoff' | 'ask' | 'review' }>,
  give: Give,
  now: string,
): { drafts: DomainEventDraft[]; exchangeId: string } {
  const { me, jobId, turnId, exchange } = turn
  const drafts: DomainEventDraft[] = []
  let used = ''
  const open = (kind: ExchangeRow['kind'], parentId: string | null) => {
    const id = openExchange(sqlite, { jobId, kind, parentId, from: me, to: action.to, turnId }, now)
    drafts.push(...exchangeEvent(sqlite, id))
    return id
  }
  switch (action.action) {
    case 'handoff': {
      const id = open('handoff', null)
      used = id
      drafts.push(...updateJob(sqlite, jobId, { holder: action.to }, now))
      give(action.to, `${me} handed this work to you.\n\n${quote(me, action.note)}`, id)
      break
    }
    case 'ask': {
      const waiting = exchange && !['done', 'stopped'].includes(exchange.state) ? exchange : null
      const id = open('ask', waiting?.id ?? null)
      used = id
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
      used = id
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
  return { drafts, exchangeId: used }
}
