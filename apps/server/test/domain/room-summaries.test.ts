import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import {
  attachRunMessage,
  completeRunMessage,
  retryReply,
  roomRunInput,
} from '../../src/domain/message-runs.ts'
import { rewindingRooms } from '../../src/domain/room-rewinding.ts'
import {
  requestSummary,
  sanitizeSummaryText,
  shouldAutoSummarise,
  SUMMARY_INSTRUCTION,
  uncoveredTokens,
  usableSummary,
} from '../../src/domain/room-summaries.ts'
import { deleteMessage, insertRoom, messageFromRow, storeMessage } from '../../src/domain/rooms.ts'
import { visibleSummaries } from '../../src/domain/summary-stale.ts'
import { createVersion } from '../../src/domain/versions.ts'

let dir: string
let db: ScoreDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-summary-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  db.sqlite
    .prepare(
      "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state) VALUES ('lead', ?, 'ready')",
    )
    .run(crypto.randomUUID())
  insertRoom(
    db.sqlite,
    { id: 'r1', name: '#team', kind: 'room', leadAgentId: 'lead', members: ['lead'] },
    '2026-10-09T08:00:00.000Z',
  )
})
afterEach(() => {
  rewindingRooms.clear()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const at = (n: number) => new Date(Date.UTC(2026, 9, 9, 9, 0, n)).toISOString()
function say(n: number, text: string, from: 'you' | 'lead' = 'you') {
  storeMessage(
    db.sqlite,
    {
      id: `m${n}`,
      roomId: 'r1',
      author: from === 'you' ? { kind: 'you' } : { kind: 'agent', agentId: 'lead' },
      to: [],
      parts: [{ kind: 'text', text }],
      createdAt: at(n),
      streaming: false,
      refs: [],
    },
    at(n),
  )
}
const enable = (thresholdTokens = 2000) =>
  db.sqlite
    .prepare('UPDATE rooms SET auto_summary = ? WHERE id = ?')
    .run(JSON.stringify({ enabled: true, thresholdTokens }), 'r1')
function finishSummary(output: string, runId = 'run-s', second = 30) {
  const turn = db.sqlite
    .prepare("SELECT turn_id FROM message_runs WHERE purpose = 'summary' ORDER BY rowid DESC")
    .get() as { turn_id: string }
  db.sqlite
    .prepare(
      "INSERT OR IGNORE INTO runs (id, profile, origin, status, started_at, updated_at) VALUES (?, 'lead', 'score', 'completed', ?, ?)",
    )
    .run(runId, at(second), at(second))
  attachRunMessage(db.sqlite, turn.turn_id, runId, at(second))
  return completeRunMessage(db.sqlite, runId, at(second + 1), { output })
}
const filler = 'x'.repeat(3000)

test('the estimate is chars / 4 of what no summary covers, and the setting is opt-in', () => {
  for (let n = 1; n <= 3; n++) say(n, filler)
  expect(uncoveredTokens(db.sqlite, 'r1')).toBe(2250)
  expect(shouldAutoSummarise(db.sqlite, 'r1')).toBe(false)
  enable(2000)
  expect(shouldAutoSummarise(db.sqlite, 'r1')).toBe(true)
  enable(4000)
  expect(shouldAutoSummarise(db.sqlite, 'r1')).toBe(false)
})

test('the summary run goes through the lead as a normal, summary-only run', () => {
  say(1, 'Please plan the launch')
  say(2, 'Plan: three steps', 'lead')
  const id = requestSummary(db.sqlite, 'r1', at(10))
  const run = db.sqlite.prepare('SELECT * FROM message_runs WHERE message_id = ?').get(id) as {
    agent_id: string
    purpose: string
    parent_message_id: string
    admission_input: string
  }
  expect(run).toMatchObject({ agent_id: 'lead', purpose: 'summary', parent_message_id: 'm2' })
  expect(run.admission_input).toContain(SUMMARY_INSTRUCTION)
  expect(run.admission_input).toContain('you: Please plan the launch')
  expect(() => requestSummary(db.sqlite, 'r1', at(11))).toThrow(/already being written/)
  // A hand-off in the summary reply, tool cards and HTML do not survive: it is text only.
  finishSummary('Decided: three steps. <script>alert(1)</script> @builder go <!-- hidden -->')
  const [summary] = visibleSummaries(db.sqlite, 'r1')
  expect(summary?.authorAgentId).toBe('lead')
  expect(summary?.part).toEqual({
    kind: 'summary',
    coversUntil: 'm2',
    text: 'Decided: three steps. alert(1) @builder go',
  })
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM message_runs WHERE hop > 0').get()).toEqual({
    n: 0,
  })
  expect(() => retryReply(db.sqlite, 'r1', id, 'n', at(40))).toThrow()
})

test('"summary + the messages after it" is the room context; the covered messages are not sent', () => {
  say(1, 'old instruction alpha')
  say(2, 'old reply beta', 'lead')
  requestSummary(db.sqlite, 'r1', at(10))
  finishSummary('Summary text gamma')
  say(40, 'newer question delta')
  say(41, 'the question being asked')
  const input = roomRunInput(db.sqlite, 'r1', 'do it', 'm41')
  expect(input).toContain('Summary text gamma')
  expect(input).toContain('written by lead')
  expect(input).toContain('you: newer question delta')
  expect(input).not.toContain('old instruction alpha')
  expect(input).not.toContain('the question being asked')
})

test('deleting a covered message marks the summary stale and stops using it until regenerated', () => {
  say(1, 'secret plan epsilon')
  say(2, 'reply', 'lead')
  requestSummary(db.sqlite, 'r1', at(10))
  finishSummary('Plan epsilon agreed')
  say(40, 'later')
  expect(usableSummary(db.sqlite, 'r1')).not.toBeNull()
  const drafts = deleteMessage(db.sqlite, 'r1', 'm1', at(50))
  const updated = drafts.find((draft) => draft.type === 'message.updated')
  expect(updated).toBeDefined()
  expect(visibleSummaries(db.sqlite, 'r1')[0]?.part.stale).toBe(true)
  expect(usableSummary(db.sqlite, 'r1')).toBeNull()
  // The plain recent window is used again, without the summary card.
  const input = roomRunInput(db.sqlite, 'r1', 'ask', 'mx')
  expect(input).not.toContain('epsilon agreed')
  expect(input).not.toContain('secret plan')
  // Regenerating replaces the stale one and summarises what is left.
  requestSummary(db.sqlite, 'r1', at(60))
  const next = finishSummary('Fresh summary', 'run-s2', 61)
  expect(next.some((draft) => draft.type === 'message.deleted')).toBe(true)
  expect(visibleSummaries(db.sqlite, 'r1')).toHaveLength(1)
  expect(usableSummary(db.sqlite, 'r1')?.part.text).toBe('Fresh summary')
})

test('rewinding to a covered message hides the summary with it', () => {
  say(1, 'first')
  say(2, 'second', 'lead')
  requestSummary(db.sqlite, 'r1', at(10))
  finishSummary('Summary of both')
  const anchor = messageFromRow(db.sqlite.prepare("SELECT * FROM messages WHERE id = 'm2'").get())
  createVersion(
    db.sqlite,
    { roomId: 'r1', anchor, mode: 'delete', scoreOnly: true, rewound: [], skipped: [] },
    at(90),
  )
  expect(visibleSummaries(db.sqlite, 'r1')).toHaveLength(0)
  expect(usableSummary(db.sqlite, 'r1')).toBeNull()
})

test('a paused or rewinding room is not summarised, a failed summary leaves a notice and is not retried at once', () => {
  say(1, filler)
  say(2, filler)
  say(3, filler)
  enable()
  db.sqlite.prepare('UPDATE team_state SET paused_at = ? WHERE id = 1').run(at(5))
  expect(shouldAutoSummarise(db.sqlite, 'r1')).toBe(false)
  expect(() => requestSummary(db.sqlite, 'r1', at(6))).toThrow(/paused/)
  db.sqlite.prepare('UPDATE team_state SET paused_at = NULL WHERE id = 1').run()
  rewindingRooms.add('r1')
  expect(shouldAutoSummarise(db.sqlite, 'r1')).toBe(false)
  expect(() => requestSummary(db.sqlite, 'r1', at(6))).toThrow(/rewound/)
  rewindingRooms.delete('r1')
  expect(shouldAutoSummarise(db.sqlite, 'r1')).toBe(true)
  requestSummary(db.sqlite, 'r1', at(10))
  finishSummary('', 'run-empty')
  expect(visibleSummaries(db.sqlite, 'r1')).toHaveLength(0)
  expect(shouldAutoSummarise(db.sqlite, 'r1')).toBe(false)
  say(60, 'one more from the person')
  expect(shouldAutoSummarise(db.sqlite, 'r1')).toBe(true)
})

test('summary text is sanitised', () => {
  expect(sanitizeSummaryText('a <b>bold</b> <img src=x onerror=1> <!-- c --> b')).toBe('a bold   b')
})
