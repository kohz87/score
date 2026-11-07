import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ThemeManifest } from '@score/contract'
import { asidePath, presentOnDisk, stagingPath, tryRemove } from './store-fs.ts'
import { eraseNote, settleNote, undoSwap, writeDown } from './store-journal.ts'
import { assertSettled } from './store-recovery.ts'
import { row, upsertTheme } from './store-records.ts'
import { ASSET_DIRS, type ThemeContext } from './store-types.ts'

/** Saves a custom theme's manifest and CSS in one transaction (assets already on disk are kept). */
export function saveCustom(context: ThemeContext, manifest: ThemeManifest, css: string): void {
  assertSettled(context, manifest.id)
  // A folder with no row is a leftover of a theme that was deleted; this new one must not inherit its files.
  if (!row(context, manifest.id) && presentOnDisk(join(context.root, manifest.id)))
    context.fs.rm(join(context.root, manifest.id))
  context.db.tx((sqlite) => upsertTheme(context, sqlite, manifest, css, 'custom'))
}

/**
 * Stores an imported theme: the assets are staged in a private folder, swapped in, then the row is written. The swap
 * is written down first (`theme_swaps`) and erased in the same transaction as the row, so after any failure, or a stop
 * between two steps, the theme is either wholly the old one or wholly the new one: a failure here puts the old folder
 * back, and one that also stops the way back is finished by `recoverInterrupted` at the next start. Files are 0600,
 * folders 0700.
 *
 * After a power cut or kernel crash (K2 X5) the same holds, because each step is on disk before the next one starts:
 * the staged files and folders are fsynced, then the note is committed at `synchronous = FULL`, then each folder move
 * is followed by an fsync of the themes folder, then the row and the note's erasure are committed at FULL, and only
 * then is the old folder deleted. So a note that survives always has the old folder (or none, for a new theme) to go
 * back to, and an old folder is never deleted while the old row could still come back. Not guaranteed: a disk or file
 * system that lies about fsync, and a system that refuses to sync folders (the swap then relies on that system's own
 * ordering of renames); any such state is repaired at the next start the same way, but the newest import may be lost.
 * The cost is a handful of fsyncs per import or delete, and nothing else on the connection runs at FULL.
 */
export function storeImported(
  context: ThemeContext,
  manifest: ThemeManifest,
  css: string,
  assets: Map<string, Buffer>,
  licenses: Record<string, string> = {},
  /** A custom theme saved with files (C4 #2) takes the same swap but stays `custom`. */
  source: 'imported' | 'custom' = 'imported',
): void {
  mkdirSync(context.root, { recursive: true, mode: 0o700 })
  chmodSync(context.root, 0o700)
  // Nothing is in flight here (this method is synchronous), so anything still written down is left over: settle it
  // before it can be mistaken for part of this swap. If this id's note can't be settled, stop: a later recovery would
  // put the old folder over whatever this swap installs.
  assertSettled(context, manifest.id)
  const token = randomUUID()
  const staged = stagingPath(context.root, token)
  const target = join(context.root, manifest.id)
  const old = asidePath(context.root, token)
  try {
    mkdirSync(join(staged, 'assets'), { recursive: true, mode: 0o700 })
    for (const dir of ASSET_DIRS) mkdirSync(join(staged, 'assets', dir), { mode: 0o700 })
    for (const [path, bytes] of assets) {
      const file = join(staged, 'assets', ...path.split('/'))
      writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' })
      chmodSync(file, 0o600)
      context.sync(file)
    }
    // The staged tree is on disk before the swap is written down, so a note never stands for files that were lost.
    for (const dir of ASSET_DIRS) context.sync(join(staged, 'assets', dir))
    context.sync(join(staged, 'assets'))
    context.sync(staged)
    const hadOld = existsSync(target)
    writeDown(context, token, 'swap', manifest.id, null, hadOld)
    try {
      if (hadOld) {
        context.fs.rename(target, old)
        context.sync(context.root)
      }
      context.fs.rename(staged, target)
      context.sync(context.root)
      context.db.durableTx((sqlite) => {
        upsertTheme(context, sqlite, manifest, css, source, licenses)
        eraseNote(sqlite, token)
      })
    } catch (error) {
      // Whatever failed, the old state comes back; if even that can't be done, the note stays for the next start.
      try {
        undoSwap(context, token, manifest.id, hadOld)
        settleNote(context, token)
      } catch {
        // left to recoverInterrupted
      }
      throw error
    }
    tryRemove(context, old)
  } finally {
    tryRemove(context, staged)
  }
}

/**
 * Removes the row and the folder; the caller has already refused built-ins and the active theme. Journaled like a
 * swap whose new folder is nothing (K2 X14): the note is committed, the folder moves aside, the row and the note go in
 * one transaction, and only then is the old folder deleted. After any failure, or a stop between two steps, the theme
 * is whole (an interrupted delete is undone by `recoverInterrupted`; delete it again) or gone (what is left is swept).
 * It is never a row with no folder, nor a folder with no row.
 */
export function removeTheme(context: ThemeContext, id: string): void {
  assertSettled(context, id)
  const token = randomUUID()
  const target = join(context.root, id)
  const old = asidePath(context.root, token)
  const hadOld = presentOnDisk(target)
  writeDown(context, token, 'swap', id, null, hadOld)
  try {
    if (hadOld) {
      context.fs.rename(target, old)
      context.sync(context.root)
    }
    context.db.durableTx((sqlite) => {
      sqlite.prepare('DELETE FROM themes WHERE id = ?').run(id)
      eraseNote(sqlite, token)
    })
  } catch (error) {
    try {
      undoSwap(context, token, id, hadOld)
      settleNote(context, token)
    } catch {
      // left to recoverInterrupted
    }
    throw error
  }
  tryRemove(context, old)
}
