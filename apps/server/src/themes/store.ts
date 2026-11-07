import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ThemeDetail, ThemeManifest, ThemeSummary } from '@score/contract'
import type { ScoreDb } from '../db/index.ts'
import { realFs, syncThemePath } from './store-fs.ts'
import { readThemeAsset, themeAssets } from './store-assets.ts'
import {
  assertSettled,
  reclaimBuiltinIds,
  recoverInterrupted,
  sweepOrphanFolders,
} from './store-recovery.ts'
import {
  existsTheme,
  getTheme,
  listThemes,
  lockedIds,
  themeSummary,
  upsertTheme,
} from './store-records.ts'
import { assertReadable, themeDetail } from './store-reads.ts'
import { removeTheme, saveCustom, storeImported } from './store-transactions.ts'
import type { StoredTheme, ThemeContext, ThemeFs } from './store-types.ts'

export { ThemeLockedError, themeEtag } from './store-types.ts'
export type { ThemeFs } from './store-types.ts'

/** Rows and asset folders of imported and custom themes; built-ins are constants or shipped packages. */
export class ThemeStore {
  readonly root: string
  private readonly context: ThemeContext

  constructor(db: ScoreDb, home: string, clock: () => number = Date.now, fs: ThemeFs = realFs) {
    this.root = join(home, 'themes')
    this.context = {
      db,
      root: this.root,
      clock,
      fs,
      sync: (path) => syncThemePath(fs, path),
    }
  }

  get(id: string): StoredTheme | null {
    return getTheme(this.context, id)
  }

  exists(id: string): boolean {
    return existsTheme(this.context, id)
  }

  summary(theme: StoredTheme): ThemeSummary {
    return themeSummary(theme)
  }

  list(): ThemeSummary[] {
    return listThemes(this.context)
  }

  /** Asset paths as `fonts/x.woff2`, sorted; only regular files, with no symlink on the way. */
  assets(id: string): string[] {
    return themeAssets(this.context, id)
  }

  /**
   * Package reads (detail, `style.css`, assets, export) of an id with an unsettled note are refused with
   * `ThemeLockedError` (409 `theme_recovering`), because the folder and the row may then be different versions.
   */
  assertReadable(id: string): void {
    assertReadable(this.context, id)
  }

  /** The bytes of one stored asset, or null when the path isn't a well-formed asset path or a safe file. */
  readAsset(id: string, path: string): Buffer | null {
    return readThemeAsset(this.context, id, path)
  }

  detail(id: string): ThemeDetail | null {
    return themeDetail(this.context, id)
  }

  /** Inserts or replaces the row of an imported or custom theme. `createdAt` is kept on a replace. */
  upsert(
    sqlite: DatabaseSync,
    manifest: ThemeManifest,
    css: string,
    source: 'imported' | 'custom',
    licenses?: Record<string, string>,
  ): void {
    upsertTheme(this.context, sqlite, manifest, css, source, licenses)
  }

  unsettledIds(): string[] {
    return [...lockedIds(this.context)]
  }

  /**
   * Tries to settle what a stop left half done, then refuses (`ThemeLockedError`) if a note for this id is still
   * standing. Every write of an id goes through here: replace, custom save, delete (and reclaim, per row).
   */
  assertSettled(id: string): void {
    assertSettled(this.context, id)
  }

  /** Saves a custom theme's manifest and CSS in one transaction (assets already on disk are kept). */
  saveCustom(manifest: ThemeManifest, css: string): void {
    saveCustom(this.context, manifest, css)
  }

  /**
   * Stores an imported theme by staging its assets, swapping its folder and then writing the row, with a durable note
   * that lets recovery finish or undo a stop at any step.
   */
  storeImported(
    manifest: ThemeManifest,
    css: string,
    assets: Map<string, Buffer>,
    licenses: Record<string, string> = {},
    source: 'imported' | 'custom' = 'imported',
  ): void {
    storeImported(this.context, manifest, css, assets, licenses, source)
  }

  recoverInterrupted(): void {
    recoverInterrupted(this.context)
  }

  reclaimBuiltinIds(): { from: string; to: string }[] {
    return reclaimBuiltinIds(this.context)
  }

  remove(id: string): void {
    removeTheme(this.context, id)
  }

  sweepOrphanFolders(): void {
    sweepOrphanFolders(this.context)
  }
}
