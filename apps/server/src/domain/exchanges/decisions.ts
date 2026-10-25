import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ExchangeDecisionRequest } from '@score/contract'
import { HttpError } from '../../errors.ts'
import { assertJobOpen } from './job-life.ts'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { agentAdmits } from '../agent-lifecycle.ts'
import { reserveMessageRun } from '../message-runs.ts'
import { storeMessage } from '../rooms.ts'
import { roomMembers } from './actions.ts'
import { z } from 'zod'
import { stopExchanges, stopTurns, TurnToStopSchema } from './apply.ts'
import { heldTurn, hold, release } from './budget.ts'
import {
  exchangeRow,
  jobRow,
  latestMessage,
  pauseOptions,
  updateExchange,
  updateJob,
} from './store.ts'

// The person's answer to a paused or stuck exchange (docs/briefs/11.1c-budgets.md). Only the options the exchange
// offers right now are accepted. Running turns to stop are returned for the caller to stop through the port.

export interface Decided {
  drafts: DomainEventDraft[]
  running: { agentId: string; runId: string }[]
}

export function decideExchange(
  sqlite: DatabaseSync,
  exchangeId: string,
  decision: ExchangeDecisionRequest,
  now: string,
): Decided {
  const exchange = exchangeRow(sqlite, exchangeId)
  if (!exchange) throw new HttpError(404, 'not_found', 'Couldn’t find that exchange.')
  // A closed or deleted job takes no decisions: reopen it (or undo the delete) first.
  assertJobOpen(sqlite, exchange.job_id)
  if (!pauseOptions(sqlite, exchange).includes(decision.option))
    throw new HttpError(409, 'conflict', 'That choice isn’t open for this exchange right now.')
  const job = jobRow(sqlite, exchange.job_id)!
  // The person decided while the lead was still deciding: the lead's turn stops (it could no longer act anyway).
  const deciding = exchange.decider_turn_id
    ? z
        .array(TurnToStopSchema)
        .parse(
          sqlite
            .prepare(
              "SELECT turn_id, state, run_id, agent_id FROM message_runs WHERE turn_id = ? AND state IN ('pending', 'active')",
            )
            .all(exchange.decider_turn_id),
        )
    : []
  const leadRunning = stopTurns(sqlite, deciding, now)
  if (exchange.decider_turn_id) updateExchange(sqlite, exchange.id, { decider_turn_id: null }, now)
  const done = (drafts: DomainEventDraft[]): Decided => ({ drafts, running: leadRunning })
  const lead = (
    sqlite.prepare('SELECT lead_agent_id FROM rooms WHERE id = ?').get(job.room_id) as {
      lead_agent_id: string | null
    }
  ).lead_agent_id
  const turn = (agentId: string, input: string) =>
    reserveMessageRun(
      sqlite,
      {
        parentMessageId: latestMessage(sqlite, job.id),
        roomId: job.room_id,
        agentId,
        chainId: latestMessage(sqlite, job.id),
        hop: 1,
        input,
        agents: roomMembers(sqlite, job.room_id),
        exchangeId: exchange.id,
        retryNonce: `decision:${randomUUID()}`,
      },
      now,
    )

  switch (decision.option) {
    case 'more_turns': {
      if (exchange.pause_reason === 'job_limit')
        sqlite
          .prepare('UPDATE jobs SET job_turn_limit = job_turn_limit + ? WHERE id = ?')
          .run(decision.turns, job.id)
      else updateExchange(sqlite, exchange.id, { budget: exchange.budget + decision.turns }, now)
      // Raising one limit doesn't lift the others: the turn is checked again (and held again if another one bites).
      return done(release(sqlite, exchange.id, now, { check: true }))
    }
    case 'more_spend':
      sqlite
        .prepare('UPDATE jobs SET spend_cap_usd = spend_cap_usd + ? WHERE id = ?')
        .run(decision.usd, job.id)
      return done(release(sqlite, exchange.id, now, { check: true }))
    case 'continue':
      // Go on without a stopped question's answer, or accept the unknown costs seen so far.
      if (exchange.pause_reason === 'cost_unknown')
        sqlite.prepare('UPDATE jobs SET cost_unknown_accepted_at = ? WHERE id = ?').run(now, job.id)
      return done(release(sqlite, exchange.id, now, { check: true }))
    case 'step_in': {
      // The person's words go into the job for everyone, and the held turn goes on with them. That one turn is the
      // person's, not the agents' spend: the limit that stopped it grows by one.
      const drafts = storeMessage(
        sqlite,
        {
          id: randomUUID(),
          roomId: job.room_id,
          author: { kind: 'you' },
          to: [],
          parts: [{ kind: 'text', text: decision.text }],
          createdAt: now,
          streaming: false,
          refs: [],
          jobId: job.id,
        },
        now,
      )
      if (exchange.pause_reason === 'job_limit')
        sqlite
          .prepare('UPDATE jobs SET job_turn_limit = job_turn_limit + 1 WHERE id = ?')
          .run(job.id)
      else if (exchange.pause_reason === 'exchange_budget')
        updateExchange(sqlite, exchange.id, { budget: exchange.budget + 1 }, now)
      return done([
        ...drafts,
        ...release(sqlite, exchange.id, now, {
          append: `The person stepped in:\n${decision.text}`,
        }),
      ])
    }
    case 'lead_decides': {
      if (!lead) throw new HttpError(409, 'conflict', 'This room has no lead.')
      const reasonWords =
        exchange.pause_reason === 'job_limit'
          ? `the job used its ${job.job_turn_limit} turns`
          : `they used ${exchange.turns_used} of ${exchange.budget} turns`
      const id = turn(
        lead,
        [
          `As the lead, decide on a paused exchange: ${exchange.from_agent_id} and ${exchange.to_agent_id} (${exchange.kind}, round ${exchange.round}) stopped because ${reasonWords} without finishing.`,
          `Read the job above, then call score_extend {turns (at most ${job.exchange_budget}), note} to let them go on, or score_stop_exchange {note} to stop it. You can do this once for this exchange; next time the person decides.`,
        ].join('\n'),
      )
      // The lead's turn is not part of the exchange's spend.
      sqlite.prepare('UPDATE message_runs SET exchange_id = NULL WHERE message_id = ?').run(id)
      const turnId = id.slice('reply:'.length)
      return done(updateExchange(sqlite, exchange.id, { decider_turn_id: turnId }, now))
    }
    case 'stop':
    case 'close': {
      if (decision.option === 'close')
        return done([
          ...updateExchange(
            sqlite,
            exchange.id,
            {
              state: 'done',
              outcome: exchange.pause_reason === 'no_decision' ? 'no_decision' : exchange.outcome,
              pause_reason: null,
              held: null,
            },
            now,
          ),
          ...updateJob(sqlite, job.id, { state: 'waiting_on_you' }, now),
        ])
      const stopped = stopExchanges(sqlite, [exchange.id], 'stopped by you', now)
      return { drafts: stopped.drafts, running: [...leadRunning, ...stopped.running] }
    }
    case 'retry':
      return done(release(sqlite, exchange.id, now))
    case 'reassign': {
      if (
        !roomMembers(sqlite, job.room_id).includes(decision.to) ||
        !agentAdmits(sqlite, decision.to)
      )
        throw new HttpError(400, 'bad_request', `${decision.to} can’t take this work.`)
      if (decision.to === exchange.from_agent_id)
        throw new HttpError(
          400,
          'bad_request',
          `${decision.to} opened this exchange; pick someone else.`,
        )
      // The exchange now runs between its opener and the new agent.
      sqlite
        .prepare('UPDATE exchanges SET to_agent_id = ? WHERE id = ?')
        .run(decision.to, exchange.id)
      return done(release(sqlite, exchange.id, now, { agentId: decision.to }))
    }
    case 'answer_to_lead': {
      const held = heldTurn(sqlite, exchange.id)
      if (!lead || !held) throw new HttpError(409, 'conflict', 'There is no answer to pass on.')
      const drafts = updateExchange(
        sqlite,
        exchange.id,
        { state: 'done', outcome: 'answered' },
        now,
      )
      drafts.push(
        ...release(sqlite, exchange.id, now, { agentId: lead, exchangeId: null }),
        ...updateExchange(sqlite, exchange.id, { state: 'done' }, now),
      )
      // The exchange the question came from waited on the asker, who can't go on: the person picks who does.
      const parent = exchange.parent_id ? exchangeRow(sqlite, exchange.parent_id) : null
      if (parent?.state === 'waiting_on_agent' && parent.to_agent_id === exchange.from_agent_id) {
        const message = latestMessage(sqlite, job.id)
        sqlite.prepare("UPDATE exchanges SET state = 'live' WHERE id = ?").run(parent.id)
        drafts.push(
          ...hold(
            sqlite,
            parent.id,
            'unreachable',
            {
              agentId: parent.to_agent_id,
              input: `Go on with this ${parent.kind}. Your question was answered while you were away; the answer went to ${lead}.`,
              parentMessageId: message,
              chainId: message,
              fromAgentId: null,
              roomId: job.room_id,
              agents: roomMembers(sqlite, job.room_id),
              exchangeId: parent.id,
            },
            now,
            `${parent.to_agent_id} can't take work right now`,
          ),
        )
      }
      return done(drafts)
    }
    case 'ask_again': {
      const reviewer = exchange.pause_reason === 'no_decision'
      const agent = reviewer ? exchange.to_agent_id : exchange.from_agent_id
      turn(
        agent,
        reviewer
          ? `The person asks you to decide on ${exchange.from_agent_id}'s work: call score_approve or score_send_back.`
          : `The person asks you to send your work back to ${exchange.to_agent_id} for review (score_review), or say it is done.`,
      )
      return done([
        ...updateExchange(
          sqlite,
          exchange.id,
          { state: reviewer ? 'live' : 'waiting_on_agent', pause_reason: null, ended_reason: null },
          now,
        ),
        ...updateJob(sqlite, job.id, { state: 'working' }, now),
      ])
    }
    case 'send_back': {
      const round = exchange.round + 1
      turn(
        exchange.from_agent_id,
        `The person sent your work back (round ${round}) because ${exchange.to_agent_id} didn't decide. They wrote:\n\n${decision.note
          .split('\n')
          .map((line) => `> ${line}`)
          .join(
            '\n',
          )}\n\nFix it, then ask ${exchange.to_agent_id} to review it again (score_review).`,
      )
      return done([
        ...updateExchange(
          sqlite,
          exchange.id,
          { state: 'waiting_on_agent', round, pause_reason: null, ended_reason: null },
          now,
        ),
        ...updateJob(sqlite, job.id, { state: 'working' }, now),
      ])
    }
  }
}

/** Stops every open exchange of a job (the job's Stop). */
export function stopJob(sqlite: DatabaseSync, jobId: string, now: string): Decided {
  if (!jobRow(sqlite, jobId)) throw new HttpError(404, 'not_found', 'Couldn’t find that job.')
  const open = sqlite
    .prepare("SELECT id FROM exchanges WHERE job_id = ? AND state NOT IN ('done', 'stopped')")
    .all(jobId) as { id: string }[]
  const stopped = stopExchanges(
    sqlite,
    open.map((row) => row.id),
    'stopped by you',
    now,
  )
  // Turns the person started in the job stop too.
  const running = sqlite
    .prepare(
      "SELECT agent_id, run_id FROM message_runs WHERE job_id = ? AND state = 'active' AND run_id IS NOT NULL AND exchange_id IS NULL",
    )
    .all(jobId) as { agent_id: string; run_id: string }[]
  sqlite
    .prepare("UPDATE message_runs SET state = 'failed' WHERE job_id = ? AND state = 'pending'")
    .run(jobId)
  return {
    drafts: [...stopped.drafts, ...updateJob(sqlite, jobId, { state: 'waiting_on_you' }, now)],
    running: [
      ...stopped.running,
      ...running.map((row) => ({ agentId: row.agent_id, runId: row.run_id })),
    ],
  }
}
