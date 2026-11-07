import type { DatabaseSync } from 'node:sqlite'
import type { ExchangeAction } from '@score/contract'
import { stageAction, turnForCapability } from '../../domain/exchanges/actions.ts'
import { hashXtc, mintXtc } from '../../domain/exchanges/capability.ts'
import { attachRunMessage, completeRunMessage } from '../../domain/message-runs.ts'
import { storeMessage } from '../../domain/rooms.ts'

export const AGENTS = ['lead', 'builder', 'reviewer', 'designer'] as const

export interface Turn {
  turnId: string
  runId: string
  agentId: string
}

export function iso(ms: number): string {
  return new Date(ms).toISOString()
}

export function minutes(nowMs: number, ago: number): string {
  return iso(nowMs - ago * 60_000)
}

export function storeText(
  sqlite: DatabaseSync,
  message: {
    id: string
    roomId: string
    jobId: string
    author: { kind: 'you' } | { kind: 'agent'; agentId: string }
    text: string
    at: string
    to?: string[]
  },
): void {
  storeMessage(
    sqlite,
    {
      id: message.id,
      roomId: message.roomId,
      author: message.author,
      to: message.to ?? [],
      parts: [{ kind: 'text', text: message.text }],
      createdAt: message.at,
      streaming: false,
      refs: [],
      jobId: message.jobId,
    },
    message.at,
  )
}

/** Marks a job read up to its newest message. There is no job-scoped counterpart of `markRoomRead`. */
export function markJobRead(sqlite: DatabaseSync, jobId: string): void {
  const newest = sqlite
    .prepare(
      'SELECT id, created_at FROM messages WHERE job_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1',
    )
    .get(jobId) as { id: string; created_at: string } | undefined
  if (!newest) return
  sqlite
    .prepare(
      `INSERT INTO job_reads (job_id, last_read_message_created_at, last_read_message_id)
       VALUES (?, ?, ?) ON CONFLICT (job_id) DO UPDATE SET
         last_read_message_created_at = excluded.last_read_message_created_at,
         last_read_message_id = excluded.last_read_message_id
       WHERE (excluded.last_read_message_created_at, excluded.last_read_message_id) >
             (job_reads.last_read_message_created_at, job_reads.last_read_message_id)`,
    )
    .run(jobId, newest.created_at, newest.id)
}

export function pendingTurn(sqlite: DatabaseSync, jobId: string, agentId: string): string {
  const row = sqlite
    .prepare(
      "SELECT turn_id FROM message_runs WHERE job_id = ? AND agent_id = ? AND state = 'pending' ORDER BY created_at, rowid LIMIT 1",
    )
    .get(jobId, agentId) as { turn_id: string } | undefined
  if (!row) throw new Error(`seedFakeTeam: no pending turn for ${agentId} in ${jobId}`)
  return row.turn_id
}

export function startTurn(
  sqlite: DatabaseSync,
  turnId: string,
  agentId: string,
  runId: string,
  at: string,
  status = 'running',
): string {
  const capability = mintXtc()
  sqlite
    .prepare('UPDATE message_runs SET xtc_hash = ? WHERE turn_id = ?')
    .run(hashXtc(capability), turnId)
  sqlite
    .prepare(
      "INSERT INTO runs (id, profile, origin, status, started_at, updated_at, cost_usd) VALUES (?, ?, 'score', ?, ?, ?, 0)",
    )
    .run(runId, agentId, status, at, at)
  attachRunMessage(sqlite, turnId, runId, at)
  return capability
}

export function act(
  sqlite: DatabaseSync,
  turn: Turn,
  capability: string,
  commandId: string,
  action: ExchangeAction,
  at: string,
): void {
  const found = turnForCapability(sqlite, capability, turn.agentId)
  if (!found) throw new Error(`seedFakeTeam: capability refused for ${turn.agentId}`)
  const receipt = stageAction(sqlite, { turn: found, commandId, action, channel: 'bridge' }, at)
  if (receipt.status === 'refused')
    throw new Error(`seedFakeTeam: ${action.action} refused: ${receipt.message}`)
}

export function finishTurn(sqlite: DatabaseSync, turn: Turn, at: string, output: string): void {
  sqlite
    .prepare("UPDATE runs SET status = 'completed', ended_at = ?, updated_at = ? WHERE id = ?")
    .run(at, at, turn.runId)
  completeRunMessage(sqlite, turn.runId, at, { output, status: 'completed', reply: output })
}

export function playTurn(
  sqlite: DatabaseSync,
  jobId: string,
  agentId: string,
  runId: string,
  at: string,
  action: ExchangeAction | undefined,
  output: string,
  commandId: string,
): Turn {
  const turnId = pendingTurn(sqlite, jobId, agentId)
  const turn = { turnId, runId, agentId }
  const capability = startTurn(sqlite, turnId, agentId, runId, at)
  if (action) act(sqlite, turn, capability, commandId, action, at)
  finishTurn(sqlite, turn, at, output)
  return turn
}
