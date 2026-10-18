import { ThemeManifestSchema, THEME_FORMAT, type ThemeManifest } from '@score/contract'
import { manifestProblems, referencedAssets } from './draft.ts'
import { readZip, writeZip, ZipError } from './zip.ts'

// Theme packages on the web side (design §1): the layout the server reads and writes, so a draft can be exported
// without saving it and an import can be looked at before it is sent.

export type ThemePackage = {
  manifest: ThemeManifest
  css: string
  /** `fonts/x.woff2` -> bytes */
  assets: Map<string, Uint8Array>
}
export type ReadResult = { ok: true; pkg: ThemePackage } | { ok: false; reasons: string[] }

const ASSET_FILE =
  /^assets\/(fonts|img)\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(woff2|png|jpg|jpeg|webp|avif)$/

export async function readThemePackage(bytes: Uint8Array): Promise<ReadResult> {
  let files: Map<string, Uint8Array>
  try {
    files = await readZip(bytes)
  } catch (error) {
    return {
      ok: false,
      reasons: [error instanceof ZipError ? error.message : 'That zip file couldn’t be read.'],
    }
  }
  const reasons: string[] = []
  const assets = new Map<string, Uint8Array>()
  for (const [name, data] of files) {
    if (name === 'theme.json' || name === 'style.css') continue
    if (ASSET_FILE.test(name)) assets.set(name.slice('assets/'.length), data)
    else reasons.push(`“${name.slice(0, 60)}” isn’t part of a theme package.`)
  }
  const json = files.get('theme.json')
  if (!json) reasons.push('theme.json is missing.')
  let manifest: ThemeManifest | null = null
  if (json) {
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json))
      const format = (value as { format?: unknown } | null)?.format
      if (typeof format === 'number' && format > THEME_FORMAT)
        reasons.push('This theme was made for a newer Score. Update Score to use it.')
      else {
        const parsed = ThemeManifestSchema.safeParse(value)
        if (parsed.success) manifest = parsed.data
        else reasons.push(...manifestProblems(value as ThemeManifest))
      }
    } catch {
      reasons.push('theme.json isn’t valid JSON.')
    }
  }
  let css = ''
  const cssBytes = files.get('style.css')
  if (cssBytes) {
    try {
      css = new TextDecoder('utf-8', { fatal: true }).decode(cssBytes).replace(/^\uFEFF/, '')
    } catch {
      reasons.push('style.css isn’t valid UTF-8 text.')
    }
  }
  if (manifest) {
    for (const path of referencedAssets({ manifest, css, uploads: {} }))
      if (!assets.has(path)) reasons.push(`asset:${path} is used but isn’t in the package.`)
  }
  if (reasons.length > 0 || !manifest) return { ok: false, reasons: reasons.slice(0, 8) }
  return { ok: true, pkg: { manifest, css, assets } }
}

const encoder = new TextEncoder()

/** `theme.json`, `style.css` when there is CSS, then the assets by path: the server's export layout. */
export function buildThemePackage(pkg: ThemePackage): Uint8Array {
  const files: [string, Uint8Array][] = [
    ['theme.json', encoder.encode(`${JSON.stringify(pkg.manifest, null, 2)}\n`)],
  ]
  if (pkg.css.length > 0) files.push(['style.css', encoder.encode(pkg.css)])
  for (const path of [...pkg.assets.keys()].sort())
    files.push([`assets/${path}`, pkg.assets.get(path)!])
  return writeZip(files)
}

export const MAX_PACKAGE_BYTES = 5 * 1024 * 1024
