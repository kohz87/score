import type { DatabaseSync } from 'node:sqlite'
import {
  EXCHANGE_LIMITS,
  ExchangeReceiptSchema,
  ROUTING_ACTIONS,
  type ExchangeAction,
  type ExchangeReceipt,
} from '@score/contract'
import { z } from 'zod'
import { agentAdmits } from '../agent-lifecycle.ts'
import { exchangeRow, jobRow, type ExchangeRow } from './store.ts'
import { hasCapabilityText, hashXtc } from './capability.ts'

// Staging an agent's action (docs/briefs/11.0-bold.md §4.2–§4.4). A call is checked at once and answered with a
// receipt; nothing happens until the turn completes (apply.ts). One routing action per turn; a second one must name
// the first in `replaces`.

export const TurnSchema = z.object({
  turn_id: z.string(),
  room_id: z.string(),
  job_id: z.string().nullable(),
  agent_id: z.string(),
  exchange_id: z.string().nullable(),
  state: z.enum(['pending', 'active', 'completed', 'failed']),
})
export type Turn = z.infer<typeof TurnSchema>

const TURN_SELECT =
  'SELECT turn_id, room_id, job_id, agent_id, exchange_id, state FROM message_runs'

/** The live turn a capability belongs to, for the agent presenting it; null for anything else. */
export function turnForCapability(
  sqlite: DatabaseSync,
  capability: string,
  agentId: string,
): Turn | null {
  const row = sqlite
    .prepare(`${TURN_SELECT} WHERE xtc_hash = ? AND state IN ('pending', 'active')`)
    .get(hashXtc(capability))
  const turn = row === undefined ? null : TurnSchema.parse(row)
  return turn && turn.agent_id === agentId ? turn : null
}

export function turnById(sqlite: DatabaseSync, turnId: string): Turn | null {
  const row = sqlite.prepare(`${TURN_SELECT} WHERE turn_id = ?`).get(turnId)
  return row === undefined ? null : TurnSchema.parse(row)
}

/** Members of a room, its lead included. */
export function roomMembers(sqlite: DatabaseSync, roomId: string): string[] {
  const row = z
    .object({ members: z.string(), lead_agent_id: z.string().nullable() })
    .parse(sqlite.prepare('SELECT members, lead_agent_id FROM rooms WHERE id = ?').get(roomId))
  const members = z.array(z.string()).parse(JSON.parse(row.members))
  return row.lead_agent_id && !members.includes(row.lead_agent_id)
    ? [...members, row.lead_agent_id]
    : members
}

export const isRouting = (action: ExchangeAction['action']): boolean =>
  ROUTING_ACTIONS.includes(action)

const StoredSchema = z.object({
  command_id: z.string(),
  action: z.string(),
  args: z.string(),
  state: z.string(),
  receipt: z.string(),
})

/** Asks above this one, counting the exchange itself when it is an ask. */
function askDepth(sqlite: DatabaseSync, exchange: ExchangeRow | null): number {
  let depth = 0
  for (let at = exchange; at; at = at.parent_id ? exchangeRow(sqlite, at.parent_id) : null)
    if (at.kind === 'ask') depth++
  return depth
}

function refusal(action: ExchangeAction, commandId: string, code: string, message: string) {
  return ExchangeReceiptSchema.parse({
    status: 'refused',
    commandId,
    action: action.action,
    code,
    message,
  })
}

/** Why this agent may not take this action in this turn, or null. */
function whyNot(sqlite: DatabaseSync, turn: Turn, action: ExchangeAction): [string, string] | null {
  const routing = z
    .object({ routing: z.string() })
    .parse(sqlite.prepare('SELECT routing FROM rooms WHERE id = ?').get(turn.room_id)).routing
  if (routing !== 'exchanges' || !turn.job_id)
    return ['not_allowed', 'This room hands work on with @mentions, not with actions.']
  const exchange = turn.exchange_id ? exchangeRow(sqlite, turn.exchange_id) : null
  if ('to' in action) {
    if (action.to === turn.agent_id) return ['self', 'You can’t send this to yourself.']
    if (!roomMembers(sqlite, turn.room_id).includes(action.to))
      return ['not_member', `${action.to} isn’t in this room.`]
    if (!agentAdmits(sqlite, action.to))
      return ['not_member', `${action.to} can’t take work right now (retired or being removed).`]
  }
  const reviewing =
    exchange?.kind === 'review' &&
    exchange.to_agent_id === turn.agent_id &&
    exchange.state === 'live'
  switch (action.action) {
    case 'approve':
    case 'send_back':
      return reviewing ? null : ['not_allowed', 'Only the reviewer of an open review can do that.']
    case 'reply':
      return exchange?.kind === 'ask' && exchange.to_agent_id === turn.agent_id
        ? null
        : ['not_allowed', 'There is no question to you to reply to in this turn.']
    case 'review': {
      const holder = jobRow(sqlite, turn.job_id)?.holder_agent_id
      return holder === turn.agent_id
        ? null
        : [
            'not_allowed',
            `Only the one who has the work (${holder ?? 'nobody yet'}) can ask for a review.`,
          ]
    }
    case 'ask':
      return askDepth(sqlite, exchange) >= EXCHANGE_LIMITS.askDepth
        ? ['not_allowed', 'Questions can’t be nested deeper; answer with what you have.']
        : null
    case 'handoff':
      return null
  }
}

function plainReceipt(sqlite: DatabaseSync, turn: Turn, action: ExchangeAction): string {
  const exchange = turn.exchange_id ? exchangeRow(sqlite, turn.exchange_id) : null
  const author = exchange?.from_agent_id ?? 'the author'
  switch (action.action) {
    case 'handoff':
      return `Will go to ${action.to} when your turn ends.`
    case 'ask':
      return `${action.to} will be asked when your turn ends; the answer comes back to you.`
    case 'review':
      return `Will go to ${action.to} for review when your turn ends.`
    case 'approve':
      return `The review will be approved when your turn ends; ${author} hears it.`
    case 'send_back':
      return `Goes back to ${author} with your notes when your turn ends.`
    case 'reply':
      return `This will be your answer to ${author}.`
  }
}

/**
 * Stages one action of a turn and returns its receipt. Idempotent on (turn, commandId); refusals are stored too (so a
 * repeat answers the same), except a capability in the arguments, which is stored nowhere.
 */
export function stageAction(
  sqlite: DatabaseSync,
  req: { turn: Turn; commandId: string; action: ExchangeAction; channel: 'bridge' | 'block' },
  now: string,
): ExchangeReceipt {
  const { turn, commandId, action } = req
  if (hasCapabilityText(action))
    return refusal(
      action,
      commandId,
      'capability_in_text',
      'A field contains something shaped like a capability; remove it.',
    )
  const stored = sqlite
    .prepare('SELECT * FROM exchange_actions WHERE turn_id = ? AND command_id = ?')
    .get(turn.turn_id, commandId)
  if (stored !== undefined)
    return ExchangeReceiptSchema.parse(JSON.parse(StoredSchema.parse(stored).receipt))
  const record = (state: 'staged' | 'refused', receipt: ExchangeReceipt) => {
    sqlite
      .prepare(
        `INSERT INTO exchange_actions (turn_id, command_id, action, args, channel, state, receipt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turn.turn_id,
        commandId,
        action.action,
        JSON.stringify(action),
        req.channel,
        state,
        JSON.stringify(receipt),
        now,
      )
    return receipt
  }
  const why = whyNot(sqlite, turn, action)
  if (why) return record('refused', refusal(action, commandId, why[0], why[1]))
  // One routing action per turn, and one reply: a later one must say which earlier one it replaces.
  const earlier = z
    .array(StoredSchema)
    .parse(
      sqlite
        .prepare("SELECT * FROM exchange_actions WHERE turn_id = ? AND state = 'staged'")
        .all(turn.turn_id),
    )
    .find((row) => isRouting(row.action as ExchangeAction['action']) === isRouting(action.action))
  if (earlier) {
    const replaces = 'replaces' in action ? action.replaces : undefined
    if (action.action !== 'reply' && replaces !== earlier.command_id)
      return record(
        'refused',
        refusal(
          action,
          commandId,
          'action_limit',
          `You already chose an action this turn (${earlier.command_id}). To change it, pass replaces: ${earlier.command_id}.`,
        ),
      )
    sqlite
      .prepare(
        "UPDATE exchange_actions SET state = 'replaced' WHERE turn_id = ? AND command_id = ?",
      )
      .run(turn.turn_id, earlier.command_id)
  }
  return record(
    'staged',
    ExchangeReceiptSchema.parse({
      status: 'staged',
      commandId,
      action: action.action,
      message: plainReceipt(sqlite, turn, action),
    }),
  )
}
