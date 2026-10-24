import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Exchange, ExchangeAction, ExchangeDecisionRequest } from '@score/contract'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { stageAction, turnForCapability } from '../../src/domain/exchanges/actions.ts'
import { hashXtc, mintXtc } from '../../src/domain/exchanges/capability.ts'
import { decideExchange, stopJob } from '../../src/domain/exchanges/decisions.ts'
import { listExchanges } from '../../src/domain/exchanges/store.ts'
import { defaultJobId } from '../../src/domain/job-sessions.ts'
import {
  attachRunMessage,
  completeRunMessage,
  MessageRunSchema,
  reserveMessageRun,
} from '../../src/domain/message-runs.ts'
import { insertRoom, storeMessage } from '../../src/domain/rooms.ts'

// A team-like room routing with exchanges, driven turn by turn as the dispatcher and the bridge would (PLAN 11.1b/c).

export const AGENTS = ['lead', 'builder', 'reviewer', 'designer']

export interface Running {
  turnId: string
  runId: string
  agentId: string
  capability: string
}

export function exchangeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'score-xh-'))
  const db: ScoreDb = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  let clock = 0
  let seq = 0
  const tick = () => new Date(Date.UTC(2026, 9, 24, 9, 0, 0, ++clock * 10)).toISOString()
  for (const id of AGENTS)
    db.sqlite
      .prepare(
        "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state) VALUES (?, ?, 'ready')",
      )
      .run(id, crypto.randomUUID())
  insertRoom(
    db.sqlite,
    { id: 'team', name: '#team', kind: 'room', leadAgentId: 'lead', members: AGENTS },
    tick(),
  )
  db.sqlite.prepare("UPDATE rooms SET routing = 'exchanges' WHERE id = 'team'").run()
  const job = () => defaultJobId(db.sqlite, 'team')!

  const h = {
    db,
    tick,
    job,
    close() {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
    /** The person writes to one agent: their message and the turn it starts. */
    ask(agentId: string, text: string) {
      const id = `m${++seq}`
      const now = tick()
      storeMessage(
        db.sqlite,
        {
          id,
          roomId: 'team',
          author: { kind: 'you' },
          to: [agentId],
          parts: [{ kind: 'text', text }],
          createdAt: now,
          streaming: false,
          refs: [],
        },
        now,
      )
      reserveMessageRun(
        db.sqlite,
        {
          parentMessageId: id,
          roomId: 'team',
          agentId,
          chainId: id,
          hop: 0,
          input: text,
          agents: AGENTS,
        },
        now,
      )
      db.sqlite.prepare('UPDATE jobs SET holder_agent_id = ? WHERE id = ?').run(agentId, job())
    },
    /** Starts the oldest queued turn of an agent: a fresh capability, then admission. */
    start(agentId: string): Running {
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
          "INSERT INTO runs (id, profile, origin, status, started_at, updated_at, cost_usd) VALUES (?, ?, 'score', 'running', ?, ?, 0)",
        )
        .run(runId, agentId, now, now)
      attachRunMessage(db.sqlite, row.turn_id, runId, now)
      return { turnId: row.turn_id, runId, agentId, capability }
    },
    act(turn: Running, action: ExchangeAction) {
      const found = turnForCapability(db.sqlite, turn.capability, turn.agentId)
      if (!found) throw new Error('capability refused')
      return stageAction(
        db.sqlite,
        { turn: found, commandId: `c${++seq}`, action, channel: 'bridge' },
        tick(),
      )
    },
    finish(turn: Running, output: string, status = 'completed') {
      db.sqlite
        .prepare('UPDATE runs SET status = ?, updated_at = ?, ended_at = ? WHERE id = ?')
        .run(status === 'completed' ? 'completed' : 'failed', tick(), tick(), turn.runId)
      return completeRunMessage(db.sqlite, turn.runId, tick(), { output, status, reply: output })
    },
    /** One whole turn: start, act, finish. */
    turn(agentId: string, action?: ExchangeAction, output = 'Done.') {
      const running = h.start(agentId)
      if (action) h.act(running, action)
      h.finish(running, output)
      return running
    },
    decide(exchangeId: string, decision: ExchangeDecisionRequest) {
      return db.tx((sqlite) => decideExchange(sqlite, exchangeId, decision, tick()))
    },
    stopJob() {
      return db.tx((sqlite) => stopJob(sqlite, job(), tick()))
    },
    exchanges: (): Exchange[] => listExchanges(db.sqlite, job()),
    pending: () =>
      db.sqlite
        .prepare(
          "SELECT agent_id, input, exchange_id FROM message_runs WHERE state = 'pending' ORDER BY rowid",
        )
        .all() as { agent_id: string; input: string; exchange_id: string | null }[],
    jobRow: () =>
      db.sqlite
        .prepare('SELECT state, job_turn_limit, spend_cap_usd FROM jobs WHERE id = ?')
        .get(job()) as {
        state: string
        job_turn_limit: number
        spend_cap_usd: number | null
      },
  }
  return h
}
export type Harness = ReturnType<typeof exchangeHarness>
