import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { asidePath, stagingPath } from './store-fs.ts'
import type { ThemeContext } from './store-types.ts'

export function writeDown(
  context: ThemeContext,
  token: string,
  kind: 'swap' | 'reclaim',
  themeId: string,
  otherId: string | null,
  hadFolder: boolean,
): void {
  context.db.durableTx((sqlite) =>
    sqlite
      .prepare(
        'INSERT INTO theme_swaps (token, kind, theme_id, other_id, had_folder, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        token,
        kind,
        themeId,
        otherId,
        hadFolder ? 1 : 0,
        new Date(context.clock()).toISOString(),
      ),
  )
}

export function eraseNote(sqlite: DatabaseSync, token: string): void {
  sqlite.prepare('DELETE FROM theme_swaps WHERE token = ?').run(token)
}

/**
 * After a rollback or a recovery step: the folder moves it made are synced before the note goes, and the erase is
 * durable, so a power cut can't keep the erase and lose the restoration (old row, new bytes, no note to recover from).
 */
export function settleNote(context: ThemeContext, token: string): void {
  if (existsSync(context.root)) context.sync(context.root)
  context.db.durableTx((sqlite) => eraseNote(sqlite, token))
}

/** Puts a swap that did not commit back as it was. Safe to repeat. */
export function undoSwap(context: ThemeContext, token: string, id: string, hadOld: boolean): void {
  const target = join(context.root, id)
  const old = asidePath(context.root, token)
  if (hadOld) {
    // The old folder is aside only if the swap got that far; if not, the target still is the old folder.
    if (existsSync(old)) {
      context.fs.rm(target)
      context.fs.rename(old, target)
    }
  } else {
    // A new theme: the note proves the row was never committed, so whatever stands in the target is the staged folder.
    context.fs.rm(target)
  }
  context.fs.rm(stagingPath(context.root, token))
}
