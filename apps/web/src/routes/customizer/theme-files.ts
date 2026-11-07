import type { ThemeDetail } from '@score/contract'
import { fetchThemeAsset, fetchThemeLicenses, loadTheme } from '../../themes/customizer/api.ts'
import { readSnapshot, ThemeChangedError, type Snapshot } from '../../themes/customizer/snapshot.ts'
import type { ThemePackage } from '../../themes/customizer/package.ts'

/**
 * The files of the version a save just wrote are the ones the package carried: the draft goes on with them and nothing
 * is read back (another writer could land in between). A file or licence the package doesn't hold is read from the
 * server at the saved revision; if that fails the snapshot is left out and files are read when needed, as before.
 */
export async function snapshotAfterSave(
  detail: ThemeDetail,
  pkg: ThemePackage,
): Promise<Snapshot | null> {
  const complete =
    detail.assets.every((path) => pkg.assets.has(path)) &&
    (detail.licenseFiles.length === 0 || Object.keys(pkg.licenses).length > 0)
  if (complete)
    return {
      assets: Object.fromEntries(detail.assets.map((path) => [path, pkg.assets.get(path)!])),
      licenses: pkg.licenses,
    }
  try {
    return await readSnapshot(
      detail.manifest.id,
      detail.etag,
      detail,
      fetchThemeAsset,
      fetchThemeLicenses,
    )
  } catch {
    return null
  }
}

/**
 * A theme and its files and licences, read at one revision, once, for the draft that is made from it. A theme replaced
 * while its files are being read (409) is read again from the start; a second miss is reported as it is.
 */
export async function loadWithSnapshot(
  id: string,
): Promise<{ detail: ThemeDetail; snapshot: Snapshot }> {
  for (let attempt = 0; ; attempt++) {
    const detail = await loadTheme(id)
    try {
      return {
        detail,
        snapshot: await readSnapshot(id, detail.etag, detail, fetchThemeAsset, fetchThemeLicenses),
      }
    } catch (error) {
      if (!(error instanceof ThemeChangedError) || attempt > 0) throw error
    }
  }
}
