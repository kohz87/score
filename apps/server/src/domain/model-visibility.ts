import type { ModelRef } from '@score/contract'
import type { ScoreDb } from '../db/index.ts'

export function readChosenModels(db: ScoreDb): ModelRef[] {
  return db.read(
    (sqlite) =>
      sqlite
        .prepare('SELECT provider, model FROM model_visibility ORDER BY provider, model')
        .all() as unknown as ModelRef[],
  )
}

/** Replaces the whole list (the settings page edits it as one). */
export function replaceChosenModels(db: ScoreDb, items: readonly ModelRef[]): void {
  db.tx((sqlite) => {
    sqlite.exec('DELETE FROM model_visibility')
    const insert = sqlite.prepare(
      'INSERT OR IGNORE INTO model_visibility (provider, model) VALUES (?, ?)',
    )
    for (const item of items) insert.run(item.provider, item.model)
  })
}
