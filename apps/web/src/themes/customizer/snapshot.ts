// A copy of a theme is built from one snapshot (contract § 16, J1): the manifest and CSS of a draft pair only with the
// files and licences of the same package revision. The server refuses a read at an older revision (409 etag_mismatch);
// the readers turn that into this error, and the copy stops with one plain sentence.

export const THEME_CHANGED_TEXT =
  'This theme changed while you were copying it. Reload and try again.'

export class ThemeChangedError extends Error {
  constructor() {
    super(THEME_CHANGED_TEXT)
    this.name = 'ThemeChangedError'
  }
}

/**
 * The files and licences of the version of a theme that is on screen, read once when it was opened or copied and kept
 * in memory (at most 5 MB, the package cap). "Save as new", "Export" and saves that rebuild the package use these bytes,
 * so they still work after another editor replaced or removed a file: the server only serves a file at its current
 * revision, and the draft's own revision may not be current any more.
 */
export type Snapshot = {
  assets: Readonly<Record<string, Uint8Array>>
  licenses: Readonly<Record<string, string>>
}

/**
 * Reads every file and licence of `id` at revision `rev`. The server answers a read at a revision that is no longer
 * current with 409 (`ThemeChangedError`): the theme changed while it was being opened, and nothing is kept.
 */
export async function readSnapshot(
  id: string,
  rev: string,
  files: { assets: readonly string[]; licenseFiles: readonly string[] },
  readAsset: (id: string, path: string, rev: string | null) => Promise<Uint8Array>,
  readLicences: (id: string, rev: string | null) => Promise<Record<string, string>>,
): Promise<Snapshot> {
  const [assets, licenses] = await Promise.all([
    Promise.all(files.assets.map(async (path) => [path, await readAsset(id, path, rev)] as const)),
    files.licenseFiles.length > 0 ? readLicences(id, rev) : Promise.resolve({}),
  ])
  return { assets: Object.fromEntries(assets), licenses }
}
