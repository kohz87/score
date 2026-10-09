import type { ScoreDb } from '../db/index.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Hourly pass for tables that would otherwise only grow: reasoning text of runs older than 30 days (the run row and its
 * tool calls stay) and the knowledge write counter, which only ever looks back one hour (and today for the counts).
 */
export function pruneAuxiliary(
  db: ScoreDb,
  { now = Date.now() }: { now?: number } = {},
): { thinking: number; knowledgeWrites: number } {
  return db.tx((sqlite) => {
    const thinking = Number(
      sqlite
        .prepare(
          `DELETE FROM run_thinking WHERE run_id IN (SELECT id FROM runs WHERE started_at < ?)
             OR run_id NOT IN (SELECT id FROM runs)`,
        )
        .run(new Date(now - 30 * DAY_MS).toISOString()).changes,
    )
    const knowledgeWrites = Number(
      sqlite.prepare('DELETE FROM knowledge_agent_writes WHERE at < ?').run(now - DAY_MS).changes,
    )
    return { thinking, knowledgeWrites }
  })
}
