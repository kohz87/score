import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  BUILTIN_THEME_IDS,
  ThemeManifestSchema,
  type ThemeDetail,
  type ThemeManifest,
  type ThemeSummary,
} from '@score/contract'
import type { ScoreDb } from '../db/index.ts'
import {
  BUILTIN_UPDATED_AT,
  builtinAssetRoot,
  builtinCss,
  builtinLicenses,
  builtinManifest,
  isBuiltinThemeId,
} from './builtin.ts'

const RowSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  manifest_json: z.string(),
  css: z.string(),
  licenses_json: z.string(),
  revision: z.number().int(),
  source: z.enum(['imported', 'custom']),
  created_at: z.string(),
  updated_at: z.string(),
})
type Row = z.infer<typeof RowSchema>
const LicensesSchema = z.record(z.string(), z.string())

export const ASSET_DIRS = ['fonts', 'img'] as const

export interface StoredTheme {
  manifest: ThemeManifest
  css: string
  source: ThemeSummary['source']
  updatedAt: string
  /** Licence files of the package (`LICENSE`, `OFL.txt`) -> text; put back into its export. */
  licenses: Record<string, string>
  /** Persisted write counter of the row (0 for a built-in); asset bytes can't be hashed cheaply, so it stands for them. */
  revision: number
}

/**
 * Conflict-check token for a whole package: the row's write number (every write bumps it, and it is what changes when
 * only assets or licence files change) together with the manifest, CSS and licence texts the row holds.
 */
export function themeEtag(
  theme: Pick<StoredTheme, 'manifest' | 'css' | 'licenses' | 'revision'>,
): string {
  return createHash('sha256')
    .update(String(theme.revision))
    .update('\0')
    .update(JSON.stringify(theme.manifest))
    .update('\0')
    .update(theme.css)
    .update('\0')
    .update(JSON.stringify(theme.licenses))
    .digest('hex')
}

/**
 * An earlier swap or id move of this theme is not settled yet: its note still stands for an old folder that recovery
 * will put back. Writing the id now would let that later step put old files under a newer row (re-gate finding 2).
 */
export class ThemeLockedError extends Error {
  constructor(readonly themeId: string) {
    super(
      'This theme is still being put back after an interrupted change. Try again in a moment, or restart Score.',
    )
  }
}

/** The two file-system moves a theme swap is made of; tests replace them to fail at a chosen step. */
export interface ThemeFs {
  rename(from: string, to: string): void
  rm(path: string): void
}
const realFs: ThemeFs = {
  rename: renameSync,
  rm: (path) => rmSync(path, { recursive: true, force: true }),
}

/** Rows and asset folders of imported and custom themes; built-ins are constants or shipped packages. */
export class ThemeStore {
  readonly root: string

  constructor(
    private readonly db: ScoreDb,
    home: string,
    private readonly clock: () => number = Date.now,
    private readonly fs: ThemeFs = realFs,
  ) {
    this.root = join(home, 'themes')
  }

  private now(): string {
    return new Date(this.clock()).toISOString()
  }

  private rows(): Row[] {
    return this.db.read((sqlite) =>
      z.array(RowSchema).parse(sqlite.prepare('SELECT * FROM themes ORDER BY id').all()),
    )
  }

  private row(id: string): Row | null {
    const found = this.db.read((sqlite) =>
      sqlite.prepare('SELECT * FROM themes WHERE id = ?').get(id),
    )
    return found === undefined ? null : RowSchema.parse(found)
  }

  private parse(row: Row): StoredTheme {
    return {
      manifest: ThemeManifestSchema.parse(JSON.parse(row.manifest_json)),
      css: row.css,
      source: row.source,
      updatedAt: row.updated_at,
      licenses: LicensesSchema.parse(JSON.parse(row.licenses_json)),
      revision: row.revision,
    }
  }

  get(id: string): StoredTheme | null {
    const manifest = builtinManifest(id)
    if (manifest)
      return {
        manifest,
        css: builtinCss(id),
        source: 'builtin',
        updatedAt: BUILTIN_UPDATED_AT,
        licenses: builtinLicenses(id),
        revision: 0,
      }
    const row = this.row(id)
    return row ? this.parse(row) : null
  }

  exists(id: string): boolean {
    return this.get(id) !== null
  }

  summary(theme: StoredTheme): ThemeSummary {
    const { manifest } = theme
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      author: manifest.author ?? null,
      description: manifest.description ?? null,
      source: theme.source,
      updatedAt: theme.updatedAt,
      hasCss: theme.css.length > 0,
    }
  }

  list(): ThemeSummary[] {
    const builtins = BUILTIN_THEME_IDS.map((id) => this.get(id)!)
    return [...builtins, ...this.rows().map((row) => this.parse(row))].map((t) => this.summary(t))
  }

  /** The folder an id's `fonts/` and `img/` are in: the shipped package for a built-in, else Score's own home. */
  assetRoot(id: string): string {
    return builtinAssetRoot(id) ?? join(this.root, id, 'assets')
  }

  /** Asset paths as `fonts/x.woff2`, sorted; only regular files (a symlink planted on disk is never listed). */
  assets(id: string): string[] {
    const found: string[] = []
    for (const dir of ASSET_DIRS) {
      const folder = join(this.assetRoot(id), dir)
      if (!existsSync(folder)) continue
      for (const name of readdirSync(folder).sort()) {
        if (lstatSync(join(folder, name)).isFile()) found.push(`${dir}/${name}`)
      }
    }
    return found
  }

  /**
   * Package reads (detail, `style.css`, assets, export) of an id with an unsettled note are refused with
   * `ThemeLockedError` (409 `theme_recovering`), because the folder and the row may then be different versions: the
   * old row with the new folder's bytes. One of the two coherent answers (the other would be reading the journal's old
   * folder); this one needs no extra state. A read tries to settle the note first, so a transient fault heals itself.
   * Built-ins are shipped constants and never locked. Cheap when nothing is pending: one query on a table that is normally empty.
   */
  assertReadable(id: string): void {
    if (isBuiltinThemeId(id) || !this.lockedIds().has(id)) return
    this.assertSettled(id)
  }

  /** The bytes of one stored asset; null when it isn't a regular file (a symlink planted on disk is never read). */
  readAsset(id: string, path: string): Buffer | null {
    const file = join(this.assetRoot(id), ...path.split('/'))
    try {
      return lstatSync(file).isFile() ? readFileSync(file) : null
    } catch {
      return null
    }
  }

  detail(id: string): ThemeDetail | null {
    this.assertReadable(id)
    const theme = this.get(id)
    if (!theme) return null
    return {
      summary: this.summary(theme),
      manifest: theme.manifest,
      css: theme.css,
      assets: this.assets(id),
      etag: themeEtag(theme),
    }
  }

  /** Inserts or replaces the row of an imported or custom theme. `createdAt` is kept on a replace. */
  upsert(
    sqlite: DatabaseSync,
    manifest: ThemeManifest,
    css: string,
    source: 'imported' | 'custom',
    licenses?: Record<string, string>,
  ): void {
    const at = this.now()
    const revision = this.nextRevision(sqlite)
    sqlite
      .prepare(
        `INSERT INTO themes (id, name, version, manifest_json, css, source, created_at, updated_at, licenses_json, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, version = excluded.version,
           manifest_json = excluded.manifest_json, css = excluded.css, source = excluded.source,
           updated_at = excluded.updated_at, revision = excluded.revision,
           licenses_json = CASE WHEN ? THEN excluded.licenses_json ELSE themes.licenses_json END`,
      )
      .run(
        manifest.id,
        manifest.name,
        manifest.version,
        JSON.stringify(manifest),
        css,
        source,
        at,
        at,
        JSON.stringify(licenses ?? {}),
        revision,
        licenses === undefined ? 0 : 1,
      )
  }

  /** The next number of the one counter every theme write takes (inside the writer's transaction). */
  private nextRevision(sqlite: DatabaseSync): number {
    const row = sqlite
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('themes.revision', '1')
         ON CONFLICT (key) DO UPDATE SET value = CAST(meta.value AS INTEGER) + 1
         RETURNING CAST(value AS INTEGER) AS n`,
      )
      .get() as { n: number }
    return row.n
  }

  /** Ids named by a note that is still standing (recovery could not settle it) (the theme, and the id a move was going to give it). */
  private lockedIds(): Set<string> {
    const found = new Set<string>()
    const rows = this.db.read((sqlite) =>
      sqlite.prepare('SELECT theme_id, other_id FROM theme_swaps').all(),
    ) as { theme_id: string; other_id: string | null }[]
    for (const row of rows) {
      found.add(row.theme_id)
      if (row.other_id) found.add(row.other_id)
    }
    return found
  }

  unsettledIds(): string[] {
    return [...this.lockedIds()]
  }

  /**
   * Tries to settle what a stop left half done, then refuses (`ThemeLockedError`) if a note for this id is still
   * standing. Every write of an id goes through here: replace, custom save, delete (and reclaim, per row).
   */
  assertSettled(id: string): void {
    this.recoverInterrupted()
    if (this.lockedIds().has(id)) throw new ThemeLockedError(id)
  }

  /** Saves a custom theme's manifest and CSS in one transaction (assets already on disk are kept). */
  saveCustom(manifest: ThemeManifest, css: string): void {
    this.assertSettled(manifest.id)
    this.db.tx((sqlite) => this.upsert(sqlite, manifest, css, 'custom'))
  }

  /**
   * Stores an imported theme: the assets are staged in a private folder, swapped in, then the row is written. The swap
   * is written down first (`theme_swaps`) and erased in the same transaction as the row, so after any failure, or a stop
   * between two steps, the theme is either wholly the old one or wholly the new one: a failure here puts the old folder
   * back, and one that also stops the way back is finished by `recoverInterrupted` at the next start. Files are 0600,
   * folders 0700.
   */
  storeImported(
    manifest: ThemeManifest,
    css: string,
    assets: Map<string, Buffer>,
    licenses: Record<string, string> = {},
    /** A custom theme saved with files (C4 #2) takes the same swap but stays `custom`. */
    source: 'imported' | 'custom' = 'imported',
  ): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    chmodSync(this.root, 0o700)
    // Nothing is in flight here (this method is synchronous), so anything still written down is left over: settle it
    // before it can be mistaken for part of this swap. If this id's note can't be settled, stop: a later recovery would
    // put the old folder over whatever this swap installs.
    this.assertSettled(manifest.id)
    const token = randomUUID()
    const staged = this.stagingPath(token)
    const target = join(this.root, manifest.id)
    const old = this.asidePath(token)
    try {
      mkdirSync(join(staged, 'assets'), { recursive: true, mode: 0o700 })
      for (const dir of ASSET_DIRS) mkdirSync(join(staged, 'assets', dir), { mode: 0o700 })
      for (const [path, bytes] of assets) {
        const file = join(staged, 'assets', ...path.split('/'))
        writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' })
        chmodSync(file, 0o600)
      }
      const hadOld = existsSync(target)
      this.writeDown(token, 'swap', manifest.id, null, hadOld)
      try {
        if (hadOld) this.fs.rename(target, old)
        this.fs.rename(staged, target)
        this.db.tx((sqlite) => {
          this.upsert(sqlite, manifest, css, source, licenses)
          this.eraseNote(sqlite, token)
        })
      } catch (error) {
        // Whatever failed, the old state comes back; if even that can't be done, the note stays for the next start.
        try {
          this.undoSwap(token, manifest.id, hadOld)
          this.db.tx((sqlite) => this.eraseNote(sqlite, token))
        } catch {
          // left to recoverInterrupted
        }
        throw error
      }
      this.tryRemove(old)
    } finally {
      this.tryRemove(staged)
    }
  }

  private stagingPath(token: string): string {
    return join(this.root, `.staging-${token}`)
  }
  private asidePath(token: string): string {
    return join(this.root, `.old-${token}`)
  }
  /** Removal that never throws: what is left behind is swept at the next start. */
  private tryRemove(path: string): void {
    try {
      this.fs.rm(path)
    } catch {
      // swept by recoverInterrupted
    }
  }

  private writeDown(
    token: string,
    kind: 'swap' | 'reclaim',
    themeId: string,
    otherId: string | null,
    hadFolder: boolean,
  ): void {
    this.db.tx((sqlite) =>
      sqlite
        .prepare(
          'INSERT INTO theme_swaps (token, kind, theme_id, other_id, had_folder, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(token, kind, themeId, otherId, hadFolder ? 1 : 0, this.now()),
    )
  }
  private eraseNote(sqlite: DatabaseSync, token: string): void {
    sqlite.prepare('DELETE FROM theme_swaps WHERE token = ?').run(token)
  }

  /** Puts a swap that did not commit back as it was. Safe to repeat. */
  private undoSwap(token: string, id: string, hadOld: boolean): void {
    const target = join(this.root, id)
    const old = this.asidePath(token)
    if (hadOld) {
      // The old folder is aside only if the swap got that far; if not, the target still is the old folder.
      if (existsSync(old)) {
        this.fs.rm(target)
        this.fs.rename(old, target)
      }
    } else {
      // A new theme: the note proves the row was never committed, so whatever stands in the target is the staged folder.
      this.fs.rm(target)
    }
    this.fs.rm(this.stagingPath(token))
  }

  /**
   * Run at start (and before every swap): undoes a swap that stopped before its row was committed, finishes an id move
   * that stopped after its folder moved, and sweeps `.staging-*` and `.old-*` leftovers. The notes name the ids that
   * were chosen; nothing is inferred from which folders happen to exist. A step that fails again keeps its note for
   * the next start.
   */
  recoverInterrupted(): void {
    if (!existsSync(this.root)) return
    const notes = this.db.read((sqlite) =>
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
        if (note.kind === 'swap') this.undoSwap(note.token, note.theme_id, note.had_folder === 1)
        else
          this.settleReclaim(note.token, note.theme_id, note.other_id ?? '', note.had_folder === 1)
        this.db.tx((sqlite) => this.eraseNote(sqlite, note.token))
      } catch {
        kept.add(note.token)
      }
    }
    for (const name of readdirSync(this.root)) {
      const match = /^\.(?:staging|old)-(.+)$/.exec(name)
      if (match && !kept.has(match[1]!)) this.tryRemove(join(this.root, name))
    }
  }

  /**
   * An id move that stopped. The note says which id the theme was going to get. If its folder had moved there, the move
   * is finished; if it had not moved yet, or the folders can't be explained by the note, the note is dropped and the
   * normal pass plans the move again from scratch.
   */
  private settleReclaim(token: string, from: string, to: string, hadFolder: boolean): void {
    const row = this.row(from)
    if (!row || this.row(to)) return
    const fromFolder = existsSync(join(this.root, from))
    const toFolder = existsSync(join(this.root, to))
    const moved = hadFolder ? !fromFolder && toFolder : !fromFolder && !toFolder
    if (moved) this.db.tx((sqlite) => this.commitReclaim(sqlite, row, to, token))
  }

  /**
   * Before 9.5 an import or a custom theme could be called harbour, ledger or studio; those ids now belong to built-in
   * themes, which would shadow it (the list would show two, and detail, export, edit and delete would all reach the
   * built-in). Run at start: such a row gets a free id (`harbour-mine`, `harbour-mine-2`, …), its asset folder moves
   * with it, and the shared look follows if it pointed at the old id. The chosen id is written down before the folder
   * moves, so a stop in between is finished with that id (`recoverInterrupted`), never one guessed from folders. An
   * id whose folder already exists is not free, whatever it holds.
   */
  reclaimBuiltinIds(): { from: string; to: string }[] {
    const moved: { from: string; to: string }[] = []
    this.recoverInterrupted()
    for (const row of this.rows().filter((item) => isBuiltinThemeId(item.id))) {
      // A note still standing for this row (or for an id it would take) is settled first; until then nothing is planned.
      const locked = this.lockedIds()
      if (locked.has(row.id)) continue
      const taken = new Set([...this.rows().map((item) => item.id), ...locked])
      const oldFolder = join(this.root, row.id)
      let to = ''
      for (let n = 1; ; n += 1) {
        const candidate = n === 1 ? `${row.id}-mine` : `${row.id}-mine-${n}`
        if (taken.has(candidate) || isBuiltinThemeId(candidate)) continue
        if (existsSync(join(this.root, candidate))) continue
        to = candidate
        break
      }
      const newFolder = join(this.root, to)
      const hadFolder = existsSync(oldFolder)
      const token = randomUUID()
      mkdirSync(this.root, { recursive: true, mode: 0o700 })
      this.writeDown(token, 'reclaim', row.id, to, hadFolder)
      try {
        if (hadFolder) this.fs.rename(oldFolder, newFolder)
      } catch {
        // Nothing moved: forget the plan and leave the theme as it was; the next start tries again.
        try {
          this.db.tx((sqlite) => this.eraseNote(sqlite, token))
        } catch {
          // a note left over is settled at the next start
        }
        continue
      }
      try {
        this.db.tx((sqlite) => this.commitReclaim(sqlite, row, to, token))
      } catch (error) {
        try {
          if (hadFolder) this.fs.rename(newFolder, oldFolder)
          this.db.tx((sqlite) => this.eraseNote(sqlite, token))
        } catch {
          // left to recoverInterrupted, which follows the note
        }
        throw error
      }
      moved.push({ from: row.id, to })
    }
    return moved
  }

  private commitReclaim(sqlite: DatabaseSync, row: Row, to: string, token: string): void {
    let manifestJson = row.manifest_json
    // "(yours)" tells it apart from the built-in of the same name in the picker.
    const name = `${row.name.slice(0, 52)} (yours)`
    try {
      manifestJson = JSON.stringify({ ...JSON.parse(row.manifest_json), id: to, name })
    } catch {
      // A manifest that can't be read keeps its text; the row is still renamed.
    }
    sqlite
      .prepare(
        'UPDATE themes SET id = ?, name = ?, manifest_json = ?, updated_at = ?, revision = ? WHERE id = ?',
      )
      .run(to, name, manifestJson, this.now(), this.nextRevision(sqlite), row.id)
    sqlite
      .prepare("UPDATE meta SET value = ? WHERE key = 'look.activeTheme' AND value = ?")
      .run(to, row.id)
    this.eraseNote(sqlite, token)
  }

  /** Removes the row and the folder; the caller has already refused built-ins and the active theme. */
  remove(id: string): void {
    this.assertSettled(id)
    this.db.tx((sqlite) => sqlite.prepare('DELETE FROM themes WHERE id = ?').run(id))
    rmSync(join(this.root, id), { recursive: true, force: true })
  }
}
