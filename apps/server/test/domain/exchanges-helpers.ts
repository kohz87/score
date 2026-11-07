import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExchangeAction, Message } from '@score/contract'
import { afterEach, beforeEach } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { stageAction, turnForCapability } from '../../src/domain/exchanges/actions.ts'
import { hashXtc, mintXtc } from '../../src/domain/exchanges/capability.ts'
import { defaultJobId } from '../../src/domain/job-sessions.ts'
import {
  attachRunMessage,
  completeRunMessage,
  MessageRunSchema,
  reserveMessageRun,
} from '../../src/domain/message-runs.ts'
import { insertRoom, messageFromRow, storeMessage } from '../../src/domain/rooms.ts'

export let db: ScoreDb
let dir: string
let clock = 0
const AGENTS = ['lead', 'builder', 'reviewer', 'designer']
export const tick = () => new Date(Date.UTC(2026, 9, 24, 9, 0, 0, ++clock * 10)).toISOString()

export function installExchangesHarness() {
  beforeEach(() => {
    clock = 0
    dir = mkdtempSync(join(tmpdir(), 'score-exchanges-'))
    db = openDatabase(join(dir, 'score.db'))
    migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
    for (const id of AGENTS)
      db.sqlite
        .prepare(
          "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state) VALUES (?, ?, 'ready')",
        )
        .run(id, crypto.randomUUID())
    room('team', 'exchanges')
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
}

export function room(id: string, routing: 'exchanges' | 'mentions') {
  insertRoom(
    db.sqlite,
    { id, name: `#${id}`, kind: 'room', leadAgentId: 'lead', members: AGENTS },
    tick(),
  )
  db.sqlite.prepare('UPDATE rooms SET routing = ? WHERE id = ?').run(routing, id)
}

let seq = 0
/** The person writes to one agent in a job: their message and the turn it starts. */
export function ask(
  agentId: string,
  text: string,
  { roomId = 'team', jobId }: { roomId?: string; jobId?: string } = {},
) {
  const id = `m${++seq}`
  const now = tick()
  storeMessage(
    db.sqlite,
    {
      id,
      roomId,
      author: { kind: 'you' },
      to: [agentId],
      parts: [{ kind: 'text', text }],
      createdAt: now,
      streaming: false,
      refs: [],
      ...(jobId ? { jobId } : {}),
    },
    now,
  )
  reserveMessageRun(
    db.sqlite,
    { parentMessageId: id, roomId, agentId, chainId: id, hop: 0, input: text, agents: AGENTS },
    now,
  )
  return id
}

export interface Running {
  turnId: string
  runId: string
  agentId: string
  capability: string
}
/** Starts the oldest queued turn of `agentId` as the dispatcher would: a fresh capability, then admission. */
export function start(agentId: string, runtime = 'hermes'): Running {
  const row = MessageRunSchema.parse(
    db.sqlite
      .prepare(
        "SELECT * FROM message_runs WHERE agent_id = ? AND state = 'pending' ORDER BY created_at, rowid LIMIT 1",
      )
      .get(agentId),
  )
  const capability = mintXtc()
  db.sqlite
    .prepare('UPDATE message_runs SET xtc_hash = ? WHERE turn_id = ?')
    .run(hashXtc(capability), row.turn_id)
  const runId = `run-${++seq}`
  const now = tick()
  db.sqlite
    .prepare(
      "INSERT INTO runs (id, profile, origin, status, started_at, updated_at, runtime) VALUES (?, ?, 'score', 'running', ?, ?, ?)",
    )
    .run(runId, agentId, now, now, runtime)
  attachRunMessage(db.sqlite, row.turn_id, runId, now)
  return { turnId: row.turn_id, runId, agentId, capability }
}

export function act(turn: Running, action: ExchangeAction, commandId = `c${++seq}`) {
  const found = turnForCapability(db.sqlite, turn.capability, turn.agentId)
  if (!found) throw new Error('capability refused')
  return stageAction(db.sqlite, { turn: found, commandId, action, channel: 'bridge' }, tick())
}

export function finish(turn: Running, output: string, status = 'completed') {
  return completeRunMessage(db.sqlite, turn.runId, tick(), { output, status, reply: output })
}

export const pending = () =>
  db.sqlite
    .prepare(
      "SELECT agent_id, input, exchange_id FROM message_runs WHERE state = 'pending' ORDER BY rowid",
    )
    .all() as { agent_id: string; input: string; exchange_id: string | null }[]
export const replyOf = (turn: Running): Message =>
  messageFromRow(
    db.sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(`reply:${turn.turnId}`),
  )
export const job = () => defaultJobId(db.sqlite, 'team')!
export const jobState = () =>
  db.sqlite.prepare('SELECT state, holder_agent_id FROM jobs WHERE id = ?').get(job())
