import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUILTIN_THEME_IDS,
  THEME_FORMAT,
  ThemeManifestSchema,
  type ThemeManifest,
} from '@score/contract'
import { LICENSE_FILES } from './license-files.ts'

// Score is the default look the web app's CSS defines (tokens.css), so it has no manifest content; the server only needs
// its identity. Every other built-in is a real theme package in the same layout an import uses, kept in
// `apps/server/themes/<id>/` and read from there: Paper, Night shift and Dense (C4: the Customizer's "Start from"
// copies their manifest exactly; the browser still wears them through the packs in `styles/packs/`, which are
// the look of record and are checked against these manifests by a test) and Harbour, Ledger and Studio (9.5).
// A Map: an id such as `constructor` or `__proto__` must not find an inherited property (K2 X12).
const PACK_NAMES = new Map<string, string>([['score', 'Score']])
export const PACKAGED_THEME_IDS = [
  'paper',
  'night',
  'dense',
  'harbour',
  'ledger',
  'studio',
] as const
export const BUILTIN_UPDATED_AT = '2026-10-18T00:00:00.000Z'
/** Where the shipped packages live. */
export const BUILTIN_THEMES_DIR = fileURLToPath(new URL('../../themes/', import.meta.url))

export function isBuiltinThemeId(id: string): boolean {
  return (BUILTIN_THEME_IDS as readonly string[]).includes(id)
}

interface Packaged {
  manifest: ThemeManifest
  css: string
  licenses: Record<string, string>
}
const packaged = new Map<string, Packaged>()

function loadPackaged(id: string): Packaged | null {
  if (!(PACKAGED_THEME_IDS as readonly string[]).includes(id)) return null
  const found = packaged.get(id)
  if (found) return found
  const dir = join(BUILTIN_THEMES_DIR, id)
  const manifest = ThemeManifestSchema.parse(
    JSON.parse(readFileSync(join(dir, 'theme.json'), 'utf8')),
  )
  if (manifest.id !== id) throw new Error(`Built-in theme ${id} has the id ${manifest.id}`)
  const cssFile = join(dir, 'style.css')
  const css = existsSync(cssFile) ? readFileSync(cssFile, 'utf8') : ''
  const licenses: Record<string, string> = {}
  for (const name of LICENSE_FILES)
    if (existsSync(join(dir, name))) licenses[name] = readFileSync(join(dir, name), 'utf8')
  const loaded = { manifest, css, licenses }
  packaged.set(id, loaded)
  return loaded
}

export function builtinManifest(id: string): ThemeManifest | null {
  const real = loadPackaged(id)
  if (real) return real.manifest
  const name = PACK_NAMES.get(id)
  if (name === undefined) return null
  return {
    format: THEME_FORMAT,
    id,
    name,
    version: '1.0.0',
    author: 'Score',
  } satisfies ThemeManifest
}

/** The stylesheet of a shipped package ('' for a package without one and for Score). */
export function builtinCss(id: string): string {
  return loadPackaged(id)?.css ?? ''
}

/** The licence files a shipped package carries (`OFL.txt` for the ones that ship a font). */
export function builtinLicenses(id: string): Record<string, string> {
  return loadPackaged(id)?.licenses ?? {}
}

/** The folder holding a shipped package's `fonts/` and `img/`, or null for a theme that has no files. */
export function builtinAssetRoot(id: string): string | null {
  return loadPackaged(id) ? join(BUILTIN_THEMES_DIR, id, 'assets') : null
}
