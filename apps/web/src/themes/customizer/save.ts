import type { ThemeManifest } from '@score/contract'
import { sanitiseCss } from '../sanitise.ts'
import { manifestProblems, referencedAssets, type Draft } from './draft.ts'
import { buildThemePackage, MAX_PACKAGE_BYTES, type ThemePackage } from './package.ts'

// Turning a draft into something that can be saved or exported: the CSS is sanitised again (the stored CSS is always the
// sanitiser's own output, design §4.1), the files the draft points at are gathered, and the way to save is chosen.

export type Built = { ok: true; pkg: ThemePackage } | { ok: false; problems: string[] }

export const MAX_CSS_BYTES = 262_144

/**
 * `source` says where files that weren't added in this session live (an installed theme's asset folder).
 * `fetchAsset` reads one of them.
 */
export async function buildFromDraft(
  draft: Draft,
  manifest: ThemeManifest,
  source: { id: string | null; assets: readonly string[] },
  fetchAsset: (id: string, path: string) => Promise<Uint8Array>,
  /** The licence texts of the theme the draft was opened or copied from (read through its export). */
  fetchLicenses: (id: string) => Promise<Record<string, string>> = async () => ({}),
): Promise<Built> {
  const problems = manifestProblems(manifest)
  const css = sanitiseCss(draft.css).css
  if (new TextEncoder().encode(css).length > MAX_CSS_BYTES)
    problems.push('The custom CSS is larger than 256 KB.')
  const assets = new Map<string, Uint8Array>()
  for (const path of referencedAssets({ manifest, css, uploads: {} })) {
    const added = draft.uploads[path]
    if (added) assets.set(path, added)
    else if (source.id && source.assets.includes(path)) {
      try {
        assets.set(path, await fetchAsset(source.id, path))
      } catch {
        problems.push(`Couldn’t read the file “${path}”. Try again.`)
      }
    } else problems.push(`The file “${path}” is used but isn’t there. Add it again or remove it.`)
  }
  let licenses: Record<string, string> = { ...draft.licenses }
  if (source.id && Object.keys(licenses).length === 0) {
    try {
      licenses = await fetchLicenses(source.id)
    } catch {
      problems.push('Couldn’t read the licence files of the theme this one comes from. Try again.')
    }
  }
  if (problems.length > 0) return { ok: false, problems }
  const pkg: ThemePackage = { manifest, css, assets, licenses }
  if (buildThemePackage(pkg).length > MAX_PACKAGE_BYTES)
    return {
      ok: false,
      problems: ['The theme is larger than 5 MB. Use smaller pictures or fonts.'],
    }
  return { ok: true, pkg }
}

/**
 * Which route saves a draft. A theme without files goes through PUT (custom themes only, with the etag check);
 * a theme with files has to travel as a zip, which stores it as an installed theme (PUT can't carry files).
 */
export function saveRoute(options: {
  asNew: boolean
  exists: boolean
  source: 'new' | 'builtin' | 'imported' | 'custom'
  hasFiles: boolean
}): 'put' | 'zip' {
  const creating = options.asNew || !options.exists
  if (options.hasFiles) return 'zip'
  return creating || options.source === 'custom' ? 'put' : 'zip'
}
