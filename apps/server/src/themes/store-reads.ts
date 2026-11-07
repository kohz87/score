import type { ThemeDetail } from '@score/contract'
import { isBuiltinThemeId } from './builtin.ts'
import { themeAssets } from './store-assets.ts'
import { getTheme, lockedIds, themeSummary } from './store-records.ts'
import { assertSettled } from './store-recovery.ts'
import { themeEtag, type ThemeContext } from './store-types.ts'

/**
 * Package reads (detail, `style.css`, assets, export) of an id with an unsettled note are refused with
 * `ThemeLockedError` (409 `theme_recovering`), because the folder and the row may then be different versions: the old row
 * with the new folder's bytes. One of the two coherent answers (the other would be reading the journal's old folder);
 * this one needs no extra state. A read tries to settle the note first, so a transient fault heals itself. Built-ins are
 * shipped constants and never locked. Cheap when nothing is pending: one query on a table that is normally empty.
 */
export function assertReadable(context: ThemeContext, id: string): void {
  if (isBuiltinThemeId(id) || !lockedIds(context).has(id)) return
  assertSettled(context, id)
}

export function themeDetail(context: ThemeContext, id: string): ThemeDetail | null {
  assertReadable(context, id)
  const theme = getTheme(context, id)
  if (!theme) return null
  return {
    summary: themeSummary(theme),
    manifest: theme.manifest,
    css: theme.css,
    assets: themeAssets(context, id),
    licenseFiles: Object.keys(theme.licenses).sort(),
    etag: themeEtag(theme),
  }
}
