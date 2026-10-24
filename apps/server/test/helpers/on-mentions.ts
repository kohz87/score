import type { ScoreDb } from '../../src/db/index.ts'

// D3.2 @mention routing, kept for rooms still on mentions (orchestration runs); rooms people talk in route with
// exchanges since 11.11.
export function onMentions(db: ScoreDb, roomId: string): void {
  db.sqlite.prepare("UPDATE rooms SET routing = 'mentions' WHERE id = ?").run(roomId)
}
