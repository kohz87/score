import { inflateRawSync, type ZlibOptions } from 'node:zlib'
import JSZip from 'jszip'
import {
  ThemeManifestSchema,
  THEME_FORMAT,
  THEME_PACKAGE_LIMITS,
  ThemePackageError,
  packageAssetExtension,
  packageFileCap,
  readZipDirectory,
  reviewPackageContent,
  reviewPackageEntries,
  tooWellCompressed,
  uploadProblem,
  type ThemeManifest,
  type ZipEntryInfo,
} from '@score/contract'
import { isBuiltinThemeId } from './builtin.ts'
import { LICENSE_FILES } from './license-files.ts'
import { checkThemeCss } from './css-check.ts'

// Theme packages: `theme.json`, optional `style.css`, `assets/fonts/*.woff2`, `assets/img/*`. The rules (paths, types by
// folder, magic bytes, licence text, file count, symlink metadata, sizes) are the contract package's, the same code the
// Customizer's reader runs (re-gate finding 10); this file adds JSZip for inflating, real-bytes caps while it does,
// and the server-only checks (CSS, built-in ids). Anything outside the layout is a rejection, not a skip.

export const MAX_UPLOAD_BYTES = THEME_PACKAGE_LIMITS.uploadBytes
export const MAX_FILES = THEME_PACKAGE_LIMITS.files
const MAX_UNPACKED_BYTES = THEME_PACKAGE_LIMITS.unpackedBytes

export class ThemeRejected extends Error {
  constructor(readonly reasons: string[]) {
    super(reasons.join('; '))
  }
}

export interface ThemePackage {
  manifest: ThemeManifest
  css: string
  /** `fonts/x.woff2` -> bytes */
  assets: Map<string, Buffer>
  /** `LICENSE` or `OFL.txt` -> its text */
  licenses: Record<string, string>
}

/** Content types by extension; the bytes are checked against the extension on import. */
export const ASSET_TYPES: Record<string, string> = {
  woff2: 'font/woff2',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
}

export const assetExtension = packageAssetExtension

/**
 * The bytes of one entry, read from the extent the shared structure check validated (`dataStart`, `packed`), not
 * through JSZip: JSZip ignores bytes that follow the end of a deflate stream, while the browser's inflater refuses
 * them, so a package could install that the Customizer shows as broken (K2 X11). Here a deflated entry must consume
 * its whole stored extent, and the inflated length must equal the declared size, as in the browser.
 */
export function inflate(bytes: Buffer, entry: ZipEntryInfo, cap: number): Buffer {
  const { name, size: declared, packed } = entry
  const raw = bytes.subarray(entry.dataStart, entry.dataStart + packed)
  if (raw.length !== packed) throw new ThemeRejected([`${name} could not be read`])
  let data: Buffer
  if (entry.method === 0) {
    data = raw
  } else {
    try {
      // `info: true` also returns the engine, whose `bytesWritten` is what the inflater consumed; @types/node omits that overload.
      const out = inflateRawSync(raw, {
        info: true,
        maxOutputLength: Math.max(1, Math.min(cap, declared)),
      } as ZlibOptions) as unknown as { buffer: Buffer; engine: { bytesWritten: number } }
      if (out.engine.bytesWritten !== raw.length)
        throw new ThemeRejected([`${name} has extra bytes after its compressed data`])
      data = out.buffer
    } catch (error) {
      if (error instanceof ThemeRejected) throw error
      if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
        throw new ThemeRejected([`${name} is larger than the zip says it is`])
      throw new ThemeRejected([`${name} could not be read`])
    }
  }
  if (data.length > cap || data.length > declared)
    throw new ThemeRejected([`${name} is larger than the zip says it is`])
  if (tooWellCompressed(data.length, packed))
    throw new ThemeRejected(['The zip compresses suspiciously well (zip bomb?)'])
  if (data.length !== declared) throw new ThemeRejected([`${name} doesn’t match its size`])
  return Buffer.from(data)
}

/** Unpacks and validates a theme zip. Throws `ThemeRejected` with every reason found. */
export async function readThemePackage(bytes: Buffer): Promise<ThemePackage> {
  const upload = uploadProblem(bytes)
  if (upload) throw new ThemeRejected([upload])
  // Before JSZip: the local headers and the central directory must name and size the same files (gate finding #1).
  let listed
  try {
    listed = readZipDirectory(bytes)
  } catch (error) {
    if (error instanceof ThemePackageError) throw new ThemeRejected([error.message])
    throw error
  }
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes, { createFolders: false })
  } catch {
    throw new ThemeRejected(['That zip file couldn’t be read'])
  }
  // Every name JSZip will use must be one the structure check listed (whatever else could rename an entry).
  const listedNames = new Set(listed.map((entry) => entry.name))
  const readNames = Object.values(zip.files).map(
    (file) => (file as unknown as { unsafeOriginalName?: string }).unsafeOriginalName ?? file.name,
  )
  if (readNames.length !== listed.length || readNames.some((name) => !listedNames.has(name)))
    throw new ThemeRejected(['That zip file couldn’t be read'])

  const entryReasons = reviewPackageEntries(listed)
  if (entryReasons.length > 0) throw new ThemeRejected(entryReasons)

  const reasons = new Set<string>()
  const content = new Map<string, Buffer>()
  let total = 0
  for (const entry of listed) {
    if (entry.isDir) continue
    if (!zip.files[entry.name]) throw new ThemeRejected(['That zip file couldn’t be read'])
    const data = inflate(bytes, entry, packageFileCap(entry.name))
    total += data.length
    if (total > MAX_UNPACKED_BYTES)
      throw new ThemeRejected([
        `The zip would unpack to more than ${MAX_UNPACKED_BYTES / 1024 / 1024} MB`,
      ])
    content.set(entry.name, data)
  }

  const checked = reviewPackageContent(content)
  for (const reason of checked.reasons) reasons.add(reason)
  const licenses = checked.licenses

  const json = content.get('theme.json')
  if (!json) reasons.add('theme.json is missing')
  const manifest = json ? parseManifest(json, reasons) : null
  let css = ''
  const cssBytes = content.get('style.css')
  const refs = new Set<string>()
  if (cssBytes) {
    try {
      css = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
        .decode(cssBytes)
        .replace(/^\uFEFF/, '')
    } catch {
      reasons.add('style.css isn’t valid UTF-8 text')
    }
    const cssCheck = checkThemeCss(css)
    for (const reason of cssCheck.reasons) reasons.add(`style.css: ${reason}`)
    for (const ref of cssCheck.assets) refs.add(ref)
  }
  if (manifest) for (const ref of manifestAssets(manifest)) refs.add(ref)
  for (const ref of refs)
    if (!content.has(`assets/${ref}`)) reasons.add(`asset:${ref} is used but not in the package`)
  if (reasons.size > 0 || !manifest) throw new ThemeRejected([...reasons])

  const assets = new Map<string, Buffer>()
  for (const [name, data] of content)
    if (name.startsWith('assets/')) assets.set(name.slice(7), data)
  return { manifest, css, assets, licenses }
}

function parseManifest(json: Buffer, reasons: Set<string>): ThemeManifest | null {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json))
  } catch {
    reasons.add('theme.json isn’t valid JSON')
    return null
  }
  const format = (value as { format?: unknown } | null)?.format
  if (typeof format === 'number' && format > THEME_FORMAT) {
    reasons.add('This theme was made for a newer Score. Update Score to use it.')
    return null
  }
  const parsed = ThemeManifestSchema.safeParse(value)
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 8))
      reasons.add(`theme.json: ${issue.path.join('.') || 'file'}: ${issue.message}`)
    return null
  }
  if (isBuiltinThemeId(parsed.data.id)) {
    reasons.add(`theme.json: the id “${parsed.data.id}” belongs to a built-in theme`)
    return null
  }
  return parsed.data
}

/** Every `asset:` reference in a manifest, as `fonts/x.woff2`. */
export function manifestAssets(manifest: ThemeManifest): string[] {
  const found = new Set<string>()
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      if (node.startsWith('asset:')) found.add(node.slice(6))
    } else if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === 'object') Object.values(node).forEach(walk)
  }
  walk(manifest)
  return [...found].sort()
}

const EPOCH = new Date('2000-01-01T00:00:00Z')

/** Export: `theme.json`, `style.css` (when there is CSS), the licence files, then assets sorted by path, fixed dates and modes. */
export async function buildThemePackage(
  manifest: ThemeManifest,
  css: string,
  assets: Map<string, Buffer>,
  licenses: Record<string, string> = {},
  /** Off for the in-memory package a save with files is checked as: it was never a zip, so no ratio to judge. */
  compress = true,
): Promise<Buffer> {
  const zip = new JSZip()
  const options = { date: EPOCH, unixPermissions: 0o644, createFolders: false }
  zip.file('theme.json', `${JSON.stringify(manifest, null, 2)}\n`, options)
  if (css.length > 0) zip.file('style.css', css, options)
  for (const name of LICENSE_FILES)
    if (licenses[name] !== undefined) zip.file(name, licenses[name], options)
  for (const path of [...assets.keys()].sort())
    zip.file(`assets/${path}`, assets.get(path)!, { ...options, compression: 'STORE' })
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: compress ? 'DEFLATE' : 'STORE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
  })
}
