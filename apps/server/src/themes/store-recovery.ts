import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { ThemeIdSchema } from '@score/contract'
import { isBuiltinThemeId } from './builtin.ts'
import { tryRemove } from './store-fs.ts'
import { eraseNote, settleNote, undoSwap, writeDown } from './store-journal.ts'
import { lockedIds, nextRevision, now, row, rows } from './store-records.ts'
import { ThemeLockedError, type Row, type ThemeContext } from './store-types.ts'

/**
 * Tries to settle what a stop left half done, then refuses (`ThemeLockedError`) if a note for this id is still
 * standing. Every write of an id goes through here: replace, custom save, delete (and reclaim, per row).
 */
export function assertSettled(context: ThemeContext, id: string): void {
  recoverInterrupted(context)
  if (lockedIds(context).has(id)) throw new ThemeLockedError(id)
}

/**
 * Run at start (and before every swap): undoes a swap that stopped before its row was committed, finishes an id move
 * that stopped after its folder moved, and sweeps `.staging-*` and `.old-*` leftovers. The notes name the ids that
 * were chosen; nothing is inferred from which folders happen to exist. A step that fails again keeps its note for
 * the next start.
 */
export function recoverInterrupted(context: ThemeContext): void {
  if (!existsSync(context.root)) return
  const notes = context.db.read((sqlite) =>
    z
      .array(
        z.object({
          token: z.string(),
          kind: z.enum(['swap', 'reclaim']),
          theme_id: z.string(),
          other_id: z.string().nullable(),
          had_folder: z.number(),
        }),
      )
      .parse(sqlite.prepare('SELECT * FROM theme_swaps ORDER BY created_at, token').all()),
  )
  const kept = new Set<string>()
  for (const note of notes) {
    try {
      if (note.kind === 'swap') undoSwap(context, note.token, note.theme_id, note.had_folder === 1)
      else
        settleReclaim(
          context,
          note.token,
          note.theme_id,
          note.other_id ?? '',
          note.had_folder === 1,
        )
      settleNote(context, note.token)
    } catch {
      kept.add(note.token)
    }
  }
  for (const name of readdirSync(context.root)) {
    const match = /^\.(?:staging|old)-(.+)$/.exec(name)
    if (match && !kept.has(match[1]!)) tryRemove(context, join(context.root, name))
  }
}

/**
 * An id move that stopped. The note says which id the theme was going to get. If its folder had moved there, the move
 * is finished; if it had not moved yet, or the folders can't be explained by the note, the note is dropped and the
 * normal pass plans the move again from scratch.
 */
function settleReclaim(
  context: ThemeContext,
  token: string,
  from: string,
  to: string,
  hadFolder: boolean,
): void {
  const found = row(context, from)
  if (!found || row(context, to)) return
  const fromFolder = existsSync(join(context.root, from))
  const toFolder = existsSync(join(context.root, to))
  const moved = hadFolder ? !fromFolder && toFolder : !fromFolder && !toFolder
  if (moved) context.db.tx((sqlite) => commitReclaim(context, sqlite, found, to, token))
}

/**
 * Before 9.5 an import or a custom theme could be called harbour, ledger or studio; those ids now belong to built-in
 * themes, which would shadow it (the list would show two, and detail, export, edit and delete would all reach the
 * built-in). Run at start: such a row gets a free id (`harbour-mine`, `harbour-mine-2`, …), its asset folder moves
 * with it, and the shared look follows if it pointed at the old id. The chosen id is written down before the folder
 * moves, so a stop in between is finished with that id (`recoverInterrupted`), never one guessed from folders. An
 * id whose folder already exists is not free, whatever it holds.
 */
export function reclaimBuiltinIds(context: ThemeContext): { from: string; to: string }[] {
  const moved: { from: string; to: string }[] = []
  recoverInterrupted(context)
  for (const found of rows(context).filter((item) => isBuiltinThemeId(item.id))) {
    // A note still standing for this row (or for an id it would take) is settled first; until then nothing is planned.
    const locked = lockedIds(context)
    if (locked.has(found.id)) continue
    const taken = new Set([...rows(context).map((item) => item.id), ...locked])
    const oldFolder = join(context.root, found.id)
    let to = ''
    for (let n = 1; ; n += 1) {
      const candidate = n === 1 ? `${found.id}-mine` : `${found.id}-mine-${n}`
      if (taken.has(candidate) || isBuiltinThemeId(candidate)) continue
      if (existsSync(join(context.root, candidate))) continue
      to = candidate
      break
    }
    const newFolder = join(context.root, to)
    const hadFolder = existsSync(oldFolder)
    const token = randomUUID()
    mkdirSync(context.root, { recursive: true, mode: 0o700 })
    writeDown(context, token, 'reclaim', found.id, to, hadFolder)
    try {
      if (hadFolder) {
        context.fs.rename(oldFolder, newFolder)
        context.sync(context.root)
      }
    } catch {
      // Nothing moved: forget the plan and leave the theme as it was; the next start tries again.
      try {
        settleNote(context, token)
      } catch {
        // a note left over is settled at the next start
      }
      continue
    }
    try {
      context.db.durableTx((sqlite) => commitReclaim(context, sqlite, found, to, token))
    } catch (error) {
      try {
        if (hadFolder) context.fs.rename(newFolder, oldFolder)
        settleNote(context, token)
      } catch {
        // left to recoverInterrupted, which follows the note
      }
      throw error
    }
    moved.push({ from: found.id, to })
  }
  return moved
}

function commitReclaim(
  context: ThemeContext,
  sqlite: DatabaseSync,
  rowToMove: Row,
  to: string,
  token: string,
): void {
  let manifestJson = rowToMove.manifest_json
  // "(yours)" tells it apart from the built-in of the same name in the picker.
  const name = `${rowToMove.name.slice(0, 52)} (yours)`
  try {
    manifestJson = JSON.stringify({ ...JSON.parse(rowToMove.manifest_json), id: to, name })
  } catch {
    // A manifest that can't be read keeps its text; the row is still renamed.
  }
  sqlite
    .prepare(
      'UPDATE themes SET id = ?, name = ?, manifest_json = ?, updated_at = ?, revision = ? WHERE id = ?',
    )
    .run(to, name, manifestJson, now(context), nextRevision(sqlite), rowToMove.id)
  sqlite
    .prepare("UPDATE meta SET value = ? WHERE key = 'look.activeTheme' AND value = ?")
    .run(to, rowToMove.id)
  eraseNote(sqlite, token)
}

/**
 * Run at start: a folder under the themes root whose id has no row (and no standing note) is what a stop or a failed
 * delete left behind; a theme later given that id would inherit its files, and the asset routes would serve them.
 * Dot-folders (`.staging-*`, `.old-*`) belong to `recoverInterrupted`.
 */
export function sweepOrphanFolders(context: ThemeContext): void {
  if (!existsSync(context.root)) return
  const keep = new Set([...rows(context).map((item) => item.id), ...lockedIds(context)])
  for (const name of readdirSync(context.root)) {
    if (name.startsWith('.') || keep.has(name) || !ThemeIdSchema.safeParse(name).success) continue
    tryRemove(context, join(context.root, name))
  }
}
