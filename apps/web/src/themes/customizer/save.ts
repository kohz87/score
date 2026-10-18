import type { ThemeManifest } from '@score/contract'
import { sanitiseCss } from '../sanitise.ts'
import { manifestProblems, referencedAssets, type Draft } from './draft.ts'
import { buildThemePackage, MAX_PACKAGE_BYTES, type ThemePackage } from './package.ts'
import { THEME_CHANGED_TEXT, ThemeChangedError, type Snapshot } from './snapshot.ts'

// Turning a draft into something that can be saved or exported: the CSS is sanitised again (the stored CSS is always the
// sanitiser's own output, design §4.1), the files the draft points at are gathered, and the way to save is chosen.

export type Built =
  | { ok: true; pkg: ThemePackage }
  /** `changed`: the source theme was replaced after the draft took its revision (nothing else is wrong with it). */
  | { ok: false; problems: string[]; changed?: true }

export const MAX_CSS_BYTES = 262_144

/**
 * `source` says where files that weren't added in this session live (an installed theme's asset folder) and the
 * package revision (`rev`, the etag of the detail the draft was opened or copied from) they belong to. Every file and
 * licence is read at that revision, so the package is one snapshot; if the theme changed meanwhile the server refuses
 * the read and the whole build stops with one sentence (contract § 16, J1). When the draft carries its snapshot
 * (`source.snapshot`, read at open, L1) nothing is read at all.
 */
export async function buildFromDraft(
  draft: Draft,
  manifest: ThemeManifest,
  source: {
    id: string | null
    assets: readonly string[]
    rev: string | null
    /** The licence files the source package has (its detail's `licenseFiles`); with none there is nothing to read. */
    licenseFiles?: readonly string[]
    /**
     * The files and licences of that revision, read when the draft was opened. They are used as they are: nothing is
     * fetched for what the snapshot holds, so a theme replaced since then doesn't stop the build.
     */
    snapshot?: Snapshot | null
  },
  fetchAsset: (id: string, path: string, rev: string | null) => Promise<Uint8Array>,
  /** The licence texts of the theme the draft was opened or copied from (read through its export). */
  fetchLicenses: (
    id: string,
    rev: string | null,
  ) => Promise<Record<string, string>> = async () => ({}),
): Promise<Built> {
  const problems = manifestProblems(manifest)
  const css = sanitiseCss(draft.css).css
  if (new TextEncoder().encode(css).length > MAX_CSS_BYTES)
    problems.push('The custom CSS is larger than 256 KB.')
  const assets = new Map<string, Uint8Array>()
  for (const path of referencedAssets({ manifest, css, uploads: {} })) {
    const added = draft.uploads[path]
    const held = source.snapshot?.assets[path]
    if (added) assets.set(path, added)
    else if (held) assets.set(path, held)
    else if (source.id && source.assets.includes(path)) {
      try {
        assets.set(path, await fetchAsset(source.id, path, source.rev))
      } catch (error) {
        if (error instanceof ThemeChangedError)
          return { ok: false, problems: [THEME_CHANGED_TEXT], changed: true }
        problems.push(`Couldn’t read the file “${path}”. Try again.`)
      }
    } else problems.push(`The file “${path}” is used but isn’t there. Add it again or remove it.`)
  }
  let licenses: Record<string, string> = { ...draft.licenses }
  if (Object.keys(licenses).length === 0 && source.snapshot)
    licenses = { ...source.snapshot.licenses }
  else if (source.id && Object.keys(licenses).length === 0 && source.licenseFiles?.length !== 0) {
    try {
      licenses = await fetchLicenses(source.id, source.rev)
    } catch (error) {
      if (error instanceof ThemeChangedError)
        return { ok: false, problems: [THEME_CHANGED_TEXT], changed: true }
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
 * Which route saves a draft. A new or custom theme goes through PUT, files included (C4 #2: the server takes the
 * theme's pictures and fonts in the same request, with the etag check). A theme installed from a zip can't be changed by
 * PUT, so a draft that replaces it travels as a zip.
 */
export function saveRoute(options: {
  asNew: boolean
  exists: boolean
  source: 'new' | 'builtin' | 'imported' | 'custom'
}): 'put' | 'zip' {
  const creating = options.asNew || !options.exists
  return creating || options.source === 'custom' ? 'put' : 'zip'
}

/** Standard base64 without `String.fromCharCode(...bytes)`, which overflows the stack on a picture. */
function toBase64(bytes: Uint8Array): string {
  let out = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step)
    out += String.fromCharCode(...bytes.subarray(i, i + step))
  return btoa(out)
}

/** The file fields of a PUT save (contract § 16), or `{}` when the theme has and needs no files. */
export type SaveFiles = {
  keep?: string[]
  assets?: Record<string, string>
  licenses?: Record<string, string>
}

/**
 * What a PUT must carry for `pkg`. `held` are the files the server already has for the theme being replaced (none for
 * a new theme or a copy); one of them that the draft didn't touch is kept instead of sent again. A theme that still has
 * files on the server but uses none now sends `keep: []`, so the unused ones are removed. Licence texts the draft holds
 * are sent; with none, the server keeps what it has.
 */
export function filesForSave(
  pkg: ThemePackage,
  held: readonly string[],
  uploads: Record<string, Uint8Array>,
): SaveFiles {
  const licenses = Object.keys(pkg.licenses).length > 0 ? { licenses: { ...pkg.licenses } } : {}
  if (pkg.assets.size === 0 && held.length === 0) return licenses
  const keep: string[] = []
  const assets: Record<string, string> = {}
  for (const [path, bytes] of pkg.assets) {
    if (held.includes(path) && !uploads[path]) keep.push(path)
    else assets[path] = toBase64(bytes)
  }
  return { keep, assets, ...licenses }
}
