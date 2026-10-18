import type { Readable } from 'node:stream'
import JSZip from 'jszip'
import { ThemeManifestSchema, THEME_FORMAT, type ThemeManifest } from '@score/contract'
import { isBuiltinThemeId } from './builtin.ts'
import { LICENSE_FILES, MAX_LICENSE_BYTES } from './license-files.ts'
import { ASSET_PATH, checkThemeCss, MAX_THEME_CSS_BYTES } from './css-check.ts'
import { checkZipStructure, ZipStructureError } from './zip-structure.ts'

// Theme packages: `theme.json`, optional `style.css`, `assets/fonts/*.woff2`, `assets/img/*`. The zip guards follow the
// Knowledge importer's (apps/server/src/knowledge/extract-worker.ts): declared sizes are untrusted, so inflation counts
// real bytes; names are judged as stored, not as jszip tidies them. Here anything outside the layout is a rejection,
// not a skip.

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
export const MAX_UNPACKED_BYTES = 20 * 1024 * 1024
export const MAX_FILES = 41
/** Folder entries count toward the zip's declared total but not toward `MAX_FILES`. */
const MAX_DECLARED_ENTRIES = 50
const MAX_JSON_BYTES = 128 * 1024
const MAX_ASSET_BYTES = 8 * 1024 * 1024
const MAX_RATIO = 100
const RATIO_FLOOR_BYTES = 64 * 1024
const FOLDERS = new Set(['assets', 'assets/fonts', 'assets/img'])

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

const hasPrefix = (bytes: Buffer, at: number, text: string) =>
  bytes.length >= at + text.length &&
  bytes.subarray(at, at + text.length).toString('latin1') === text

const MAGIC: Record<string, (bytes: Buffer) => boolean> = {
  woff2: (b) => hasPrefix(b, 0, 'wOF2'),
  png: (b) =>
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => hasPrefix(b, 0, 'RIFF') && hasPrefix(b, 8, 'WEBP'),
  avif: (b) => hasPrefix(b, 4, 'ftypavif'),
}
MAGIC.jpeg = MAGIC.jpg!

/** Content types by extension; the bytes are checked against the extension on import. */
export const ASSET_TYPES: Record<string, string> = {
  woff2: 'font/woff2',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
}

export function assetExtension(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1).toLowerCase()
}

/** Zip, gzip, 7z, rar or tar signatures: a package never carries another archive. */
function looksLikeArchive(bytes: Buffer): boolean {
  return (
    hasPrefix(bytes, 0, 'PK\x03\x04') ||
    hasPrefix(bytes, 0, 'PK\x05\x06') ||
    (bytes[0] === 0x1f && bytes[1] === 0x8b) ||
    hasPrefix(bytes, 0, '7z\xbc\xaf\x27\x1c') ||
    hasPrefix(bytes, 0, 'Rar!') ||
    hasPrefix(bytes, 257, 'ustar')
  )
}

function declaredEntryCount(bytes: Buffer): number {
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1)
    if (bytes.readUInt32LE(at) === 0x06054b50) return bytes.readUInt16LE(at + 10)
  return 0
}

/** NUL and the other control characters, except tab and the line breaks. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true
  }
  return false
}

function pathProblem(raw: string): string | null {
  if (raw.includes('\\')) return 'backslash in the path'
  if (raw.includes('\0')) return 'unsafe path'
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return 'absolute path'
  const segments = raw.replace(/\/$/, '').split('/')
  if (segments.some((s) => s === '..')) return 'path leaves the folder'
  if (segments.some((s) => s === '' || s === '.')) return 'unsafe path'
  return null
}

const NESTED_ARCHIVE_NAME = /\.(?:zip|tar|gz|tgz|bz2|xz|7z|rar|jar)$/i

function allowed(path: string): boolean {
  if (path === 'theme.json' || path === 'style.css') return true
  if ((LICENSE_FILES as readonly string[]).includes(path)) return true
  const match = /^assets\/(fonts|img)\/(.+)$/.exec(path)
  if (!match || !ASSET_PATH.test(`${match[1]}/${match[2]}`)) return false
  return match[1] === 'fonts' ? path.endsWith('.woff2') : !path.endsWith('.woff2')
}

interface Declared {
  uncompressedSize?: number
  compressedSize?: number
}

function inflate(
  file: JSZip.JSZipObject,
  name: string,
  declared: number | null,
  packed: number | null,
  cap: number,
) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    const stream = file.nodeStream('nodebuffer') as unknown as Readable
    const stop = (reason: string) => {
      stream.destroy()
      reject(new ThemeRejected([reason]))
    }
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > cap || (declared !== null && total > declared))
        return stop(`${name} is larger than the zip says it is`)
      if (total > RATIO_FLOOR_BYTES && total > MAX_RATIO * Math.max(packed ?? 1, 1))
        return stop('The zip compresses suspiciously well (zip bomb?)')
      chunks.push(chunk)
    })
    stream.on('error', () => reject(new ThemeRejected([`${name} could not be read`])))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

/** Unpacks and validates a theme zip. Throws `ThemeRejected` with every reason found. */
export async function readThemePackage(bytes: Buffer): Promise<ThemePackage> {
  if (bytes.length > MAX_UPLOAD_BYTES)
    throw new ThemeRejected([`The zip is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`])
  if (!hasPrefix(bytes, 0, 'PK\x03\x04')) throw new ThemeRejected(['That isn’t a zip file'])
  if (declaredEntryCount(bytes) > MAX_DECLARED_ENTRIES)
    throw new ThemeRejected([`The zip holds more than ${MAX_FILES} files`])
  // Before JSZip: the local headers and the central directory must name and size the same files (gate finding #1).
  let listed
  try {
    listed = checkZipStructure(bytes)
  } catch (error) {
    if (error instanceof ZipStructureError) throw new ThemeRejected([error.message])
    throw error
  }
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes, { createFolders: false })
  } catch {
    throw new ThemeRejected(['That zip file couldn’t be read'])
  }
  if (Object.keys(zip.files).length !== listed.length)
    throw new ThemeRejected(['That zip file couldn’t be read'])

  const reasons = new Set<string>()
  const files = new Map<
    string,
    { file: JSZip.JSZipObject; size: number | null; packed: number | null }
  >()
  const seen = new Set<string>()
  let declaredTotal = 0
  for (const [sanitised, file] of Object.entries(zip.files)) {
    // jszip strips `..` from `name`; the name as stored in the archive is what is judged.
    const raw = (file as unknown as { unsafeOriginalName?: string }).unsafeOriginalName ?? sanitised
    const shown = raw.replaceAll('\\', '/').slice(0, 120)
    const problem = pathProblem(raw)
    if (problem) {
      reasons.add(`${shown}: ${problem}`)
      continue
    }
    const mode = file.unixPermissions
    if (typeof mode === 'number' && (mode & 0o170000) === 0o120000) {
      reasons.add(`${shown}: symbolic links are not allowed`)
      continue
    }
    if (file.dir) {
      if (!FOLDERS.has(raw.replace(/\/$/, ''))) reasons.add(`${shown}: not part of a theme package`)
      continue
    }
    if (NESTED_ARCHIVE_NAME.test(raw)) {
      reasons.add(`${shown}: archives inside a theme package are not allowed`)
      continue
    }
    if (!allowed(raw)) {
      reasons.add(`${shown}: not part of a theme package`)
      continue
    }
    if (seen.has(raw.toLowerCase())) {
      reasons.add(`${shown}: duplicate name`)
      continue
    }
    seen.add(raw.toLowerCase())
    const data = (file as unknown as { _data?: Declared })._data
    const size = typeof data?.uncompressedSize === 'number' ? data.uncompressedSize : null
    const packed = typeof data?.compressedSize === 'number' ? data.compressedSize : null
    const cap =
      raw === 'style.css'
        ? MAX_THEME_CSS_BYTES
        : raw === 'theme.json'
          ? MAX_JSON_BYTES
          : (LICENSE_FILES as readonly string[]).includes(raw)
            ? MAX_LICENSE_BYTES
            : MAX_ASSET_BYTES
    if (size !== null && size > cap) {
      reasons.add(`${shown}: file too large`)
      continue
    }
    if (size !== null && size > RATIO_FLOOR_BYTES && size > MAX_RATIO * Math.max(packed ?? 1, 1))
      throw new ThemeRejected(['The zip compresses suspiciously well (zip bomb?)'])
    declaredTotal += size ?? 0
    if (declaredTotal > MAX_UNPACKED_BYTES)
      throw new ThemeRejected([
        `The zip would unpack to more than ${MAX_UNPACKED_BYTES / 1024 / 1024} MB`,
      ])
    files.set(raw, { file, size, packed })
  }
  if (files.size > MAX_FILES)
    throw new ThemeRejected([`The zip holds more than ${MAX_FILES} files`])
  if (reasons.size > 0) throw new ThemeRejected([...reasons])

  const content = new Map<string, Buffer>()
  let total = 0
  for (const [name, entry] of files) {
    const cap =
      name === 'style.css'
        ? MAX_THEME_CSS_BYTES
        : name === 'theme.json'
          ? MAX_JSON_BYTES
          : (LICENSE_FILES as readonly string[]).includes(name)
            ? MAX_LICENSE_BYTES
            : MAX_ASSET_BYTES
    const data = await inflate(entry.file, name, entry.size, entry.packed, cap)
    total += data.length
    if (total > MAX_UNPACKED_BYTES)
      throw new ThemeRejected([
        `The zip would unpack to more than ${MAX_UNPACKED_BYTES / 1024 / 1024} MB`,
      ])
    content.set(name, data)
  }

  for (const [name, data] of content) {
    if (looksLikeArchive(data)) {
      reasons.add(`${name}: archives inside a theme package are not allowed`)
      continue
    }
    if (name.startsWith('assets/') && !MAGIC[assetExtension(name)]?.(data))
      reasons.add(`${name}: the file isn’t really a ${assetExtension(name)} file`)
  }

  const licenses: Record<string, string> = {}
  for (const name of LICENSE_FILES) {
    const bytes = content.get(name)
    if (!bytes) continue
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
      // Plain text only: no NUL or other control characters besides tab and line breaks.
      if (hasControlCharacter(text)) reasons.add(`${name} isn’t plain text`)
      else licenses[name] = text
    } catch {
      reasons.add(`${name} isn’t valid UTF-8 text`)
    }
  }

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
    const checked = checkThemeCss(css)
    for (const reason of checked.reasons) reasons.add(`style.css: ${reason}`)
    for (const ref of checked.assets) refs.add(ref)
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
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
  })
}
