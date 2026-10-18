// The rules a theme package must meet, shared by the Customizer's reader (apps/web) and the installing reader
// (apps/server) so that what the browser previews is what the server accepts. Pure: bytes in, verdicts out; no Node or
// browser APIs. Gate findings #1 and #10 (Phase 9 re-gate).
//
// Three layers, each used by both readers in this order:
//   1. `readZipDirectory`: the zip's own structure, judged from the raw bytes (central directory against local headers,
//      names, extra fields, flags, symlink metadata, overlapping data).
//   2. `reviewPackageEntries`: what the entries are called and how big they say they are (layout, types by folder,
//      file count, caps, compression ratio), before anything is inflated.
//   3. `reviewPackageContent`: the inflated bytes (magic bytes per type, nested archives, licence text).
// Inflating itself (and the real-bytes caps while doing it) stays with each reader, since it needs a platform API.

export class ThemePackageError extends Error {}

/** Licence texts a theme package may carry at its root (fonts and pictures usually come with one). */
export const THEME_LICENSE_FILES = ['LICENSE', 'OFL.txt'] as const

export const THEME_PACKAGE_LIMITS = {
  uploadBytes: 5 * 1024 * 1024,
  unpackedBytes: 20 * 1024 * 1024,
  /** Files, folders not counted. */
  files: 41,
  /** Entries the zip may declare, folders included. */
  declaredEntries: 50,
  jsonBytes: 128 * 1024,
  cssBytes: 262_144,
  assetBytes: 8 * 1024 * 1024,
  licenseBytes: 64 * 1024,
  ratio: 100,
  ratioFloorBytes: 64 * 1024,
} as const

/** `asset:` paths a package may carry and name, without the prefix: `fonts/x.woff2`, `img/y.png`. */
export const THEME_ASSET_PATH =
  /^(?:fonts|img)\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:woff2|png|jpg|jpeg|webp|avif)$/

const FOLDERS = new Set(['assets', 'assets/fonts', 'assets/img'])
const NESTED_ARCHIVE_NAME = /\.(?:zip|tar|gz|tgz|bz2|xz|7z|rar|jar)$/i

// ---------------------------------------------------------------------------------------------------------------
// 1. Structure

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const EXTRA_UNICODE_PATH = 0x7075

export interface ZipEntryInfo {
  name: string
  isDir: boolean
  flags: number
  method: number
  crc: number
  /** Stored (compressed) size and real size, as the central directory declares them. */
  packed: number
  size: number
  localOffset: number
  /** Where the entry's stored bytes begin (after the local header, its name and extra field). */
  dataStart: number
  /** The Unix mode when the entry was made on Unix, else null. */
  unixMode: number | null
}

const mismatch = (name: string) =>
  new ThemePackageError(`${name.slice(0, 60)}: the zip’s headers don’t match each other`)

/**
 * Walks the extra-field records of a zip header (`id`, `size`, data). A record that runs past the field is malformed.
 * The Info-ZIP Unicode Path record (0x7075) replaces the entry's name for readers that honour it, so a previewing
 * reader and an installing reader could see different names; no package may carry one. Other records (timestamps,
 * Unicode comments, unknown ones) don't change what a file is called and are ignored.
 */
export function extraFieldProblem(extra: Uint8Array): string | null {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength)
  let at = 0
  while (at < extra.length) {
    if (at + 4 > extra.length) return 'a header has a malformed extra field'
    const id = view.getUint16(at, true)
    const size = view.getUint16(at + 2, true)
    if (at + 4 + size > extra.length) return 'a header has a malformed extra field'
    if (id === EXTRA_UNICODE_PATH) return 'a header carries a second, Unicode name for the file'
    at += 4 + size
  }
  return null
}

/** Up to the point an upload is looked into at all: its size and the zip signature. Null when it passes. */
export function uploadProblem(bytes: Uint8Array): string | null {
  if (bytes.length > THEME_PACKAGE_LIMITS.uploadBytes)
    return `The zip is larger than ${THEME_PACKAGE_LIMITS.uploadBytes / 1024 / 1024} MB`
  if (!startsWith(bytes, 0, 'PK\x03\x04')) return 'That isn’t a zip file'
  return null
}

/**
 * The entries of a zip, judged from the raw bytes. Throws `ThemePackageError` unless the central directory and the
 * local headers describe the same files: names (valid UTF-8, unique), method, the flags that change how a name or data
 * is read, sizes, extra fields (no second name), and stored data that never overlaps.
 */
export function readZipDirectory(bytes: Uint8Array): ZipEntryInfo[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const unreadable = () => new ThemePackageError('That zip file couldn’t be read')
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (view.getUint32(at, true) === EOCD) {
      end = at
      break
    }
  }
  if (end < 0) throw unreadable()
  // A comment that stops short of the end could hide a second end record; readers could pick different ones.
  if (end + 22 + view.getUint16(end + 20, true) !== bytes.length)
    throw new ThemePackageError('That zip file has data after its end record')
  const disk = view.getUint16(end + 4, true)
  const centralDisk = view.getUint16(end + 6, true)
  const onDisk = view.getUint16(end + 8, true)
  const count = view.getUint16(end + 10, true)
  const centralSize = view.getUint32(end + 12, true)
  const centralStart = view.getUint32(end + 16, true)
  if (disk !== 0 || centralDisk !== 0 || onDisk !== count)
    throw new ThemePackageError('Zips in several parts are not allowed')
  if (count === 0xffff || centralStart === 0xffffffff || centralSize === 0xffffffff)
    throw new ThemePackageError('Zip64 packages are not allowed')
  if (count > THEME_PACKAGE_LIMITS.declaredEntries)
    throw new ThemePackageError(`The zip holds more than ${THEME_PACKAGE_LIMITS.files} files`)
  if (centralStart + centralSize !== end)
    throw new ThemePackageError('That zip file has data between its files and its file list')

  const decoder = new TextDecoder('utf-8', { fatal: true })
  const entries: ZipEntryInfo[] = []
  const names = new Set<string>()
  const ranges: [number, number, string][] = []
  let at = centralStart
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > end || view.getUint32(at, true) !== CENTRAL) throw unreadable()
    const madeBy = view.getUint16(at + 4, true)
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const crc = view.getUint32(at + 16, true)
    const packed = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const external = view.getUint32(at + 38, true)
    const localOffset = view.getUint32(at + 42, true)
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength)
    const next = at + 46 + nameLength + extraLength + commentLength
    if (next > end) throw unreadable()
    let name: string
    try {
      name = decoder.decode(nameBytes)
    } catch {
      throw new ThemePackageError('A file name in the zip isn’t valid text')
    }
    const extra = extraFieldProblem(
      bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength),
    )
    if (extra) throw new ThemePackageError(`${name.slice(0, 60)}: ${extra}`)
    at = next

    if ((flags & 0x41) !== 0) throw new ThemePackageError('That zip file is encrypted')
    if (packed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff)
      throw new ThemePackageError('Zip64 packages are not allowed')
    const key = name.replace(/\/$/, '')
    if (names.has(key))
      throw new ThemePackageError(`${name.slice(0, 60)}: appears twice in the zip (duplicate name)`)
    names.add(key)

    if (localOffset + 30 > centralStart || view.getUint32(localOffset, true) !== LOCAL)
      throw unreadable()
    const localFlags = view.getUint16(localOffset + 6, true)
    const localMethod = view.getUint16(localOffset + 8, true)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)
    if (localName.length !== nameBytes.length || localName.some((byte, i) => byte !== nameBytes[i]))
      throw mismatch(name)
    if (localMethod !== method || (localFlags & 0x801) !== (flags & 0x801)) throw mismatch(name)
    // With a data descriptor (bit 3) the local header's crc and sizes are zero; otherwise they must match.
    if ((localFlags & 8) === 0) {
      if (
        view.getUint32(localOffset + 14, true) !== crc ||
        view.getUint32(localOffset + 18, true) !== packed ||
        view.getUint32(localOffset + 22, true) !== size
      )
        throw mismatch(name)
    }
    const localExtra = extraFieldProblem(
      bytes.subarray(
        localOffset + 30 + localNameLength,
        localOffset + 30 + localNameLength + localExtraLength,
      ),
    )
    if (localExtra) throw new ThemePackageError(`${name.slice(0, 60)}: ${localExtra}`)
    if (method !== 0 && method !== 8)
      throw new ThemePackageError('That zip file uses a method Score can’t read')
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + packed
    if (dataEnd > centralStart) throw new ThemePackageError('That zip file is cut short')
    ranges.push([localOffset, dataEnd, name])
    entries.push({
      name,
      isDir: name.endsWith('/'),
      flags,
      method,
      crc,
      packed,
      size,
      localOffset,
      dataStart,
      // Made on Unix (host 3): the high half of the external attributes is the file mode.
      unixMode: madeBy >> 8 === 3 ? external >>> 16 : null,
    })
  }
  if (at !== end) throw unreadable()

  ranges.sort((a, b) => a[0] - b[0])
  for (let i = 1; i < ranges.length; i += 1)
    if (ranges[i]![0] < ranges[i - 1]![1]) throw mismatch(ranges[i]![2])
  return entries
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Entries: layout, types by folder, counts and declared sizes

function pathProblem(raw: string): string | null {
  if (raw.includes('\\')) return 'backslash in the path'
  if (raw.includes('\0')) return 'unsafe path'
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return 'absolute path'
  const segments = raw.replace(/\/$/, '').split('/')
  if (segments.some((s) => s === '..')) return 'path leaves the folder'
  if (segments.some((s) => s === '' || s === '.')) return 'unsafe path'
  return null
}

const isLicenseFile = (path: string) => (THEME_LICENSE_FILES as readonly string[]).includes(path)

function allowedPath(path: string): boolean {
  if (path === 'theme.json' || path === 'style.css' || isLicenseFile(path)) return true
  const match = /^assets\/(fonts|img)\/(.+)$/.exec(path)
  if (!match || !THEME_ASSET_PATH.test(`${match[1]}/${match[2]}`)) return false
  return match[1] === 'fonts' ? path.endsWith('.woff2') : !path.endsWith('.woff2')
}

/** The largest a file of the package may be, by its place in it. */
export function packageFileCap(path: string): number {
  if (path === 'style.css') return THEME_PACKAGE_LIMITS.cssBytes
  if (path === 'theme.json') return THEME_PACKAGE_LIMITS.jsonBytes
  if (isLicenseFile(path)) return THEME_PACKAGE_LIMITS.licenseBytes
  return THEME_PACKAGE_LIMITS.assetBytes
}

const bombReason = 'The zip compresses suspiciously well (zip bomb?)'

/** True when real bytes so far exceed what the compression ratio allows for the stored size. */
export function tooWellCompressed(unpacked: number, packed: number): boolean {
  return (
    unpacked > THEME_PACKAGE_LIMITS.ratioFloorBytes &&
    unpacked > THEME_PACKAGE_LIMITS.ratio * Math.max(packed, 1)
  )
}

/** Every reason the entries are not a theme package (empty when they are). Nothing has been inflated yet. */
export function reviewPackageEntries(entries: readonly ZipEntryInfo[]): string[] {
  const reasons = new Set<string>()
  const seen = new Set<string>()
  let files = 0
  let declaredTotal = 0
  for (const entry of entries) {
    const raw = entry.name
    const shown = raw.replaceAll('\\', '/').slice(0, 120)
    const problem = pathProblem(raw)
    if (problem) {
      reasons.add(`${shown}: ${problem}`)
      continue
    }
    if (entry.unixMode !== null && (entry.unixMode & 0o170000) === 0o120000) {
      reasons.add(`${shown}: symbolic links are not allowed`)
      continue
    }
    if (entry.isDir) {
      if (!FOLDERS.has(raw.replace(/\/$/, ''))) reasons.add(`${shown}: not part of a theme package`)
      continue
    }
    if (NESTED_ARCHIVE_NAME.test(raw)) {
      reasons.add(`${shown}: archives inside a theme package are not allowed`)
      continue
    }
    if (!allowedPath(raw)) {
      reasons.add(`${shown}: not part of a theme package`)
      continue
    }
    if (seen.has(raw.toLowerCase())) {
      reasons.add(`${shown}: duplicate name`)
      continue
    }
    seen.add(raw.toLowerCase())
    if (entry.size > packageFileCap(raw)) {
      reasons.add(`${shown}: file too large`)
      continue
    }
    if (tooWellCompressed(entry.size, entry.packed)) return [bombReason]
    declaredTotal += entry.size
    if (declaredTotal > THEME_PACKAGE_LIMITS.unpackedBytes)
      return [
        `The zip would unpack to more than ${THEME_PACKAGE_LIMITS.unpackedBytes / 1024 / 1024} MB`,
      ]
    files += 1
  }
  if (files > THEME_PACKAGE_LIMITS.files)
    return [`The zip holds more than ${THEME_PACKAGE_LIMITS.files} files`]
  return [...reasons]
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Content

function startsWith(bytes: Uint8Array, at: number, text: string): boolean {
  if (bytes.length < at + text.length) return false
  for (let i = 0; i < text.length; i += 1) if (bytes[at + i] !== text.charCodeAt(i)) return false
  return true
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const MAGIC: Record<string, (bytes: Uint8Array) => boolean> = {
  woff2: (b) => startsWith(b, 0, 'wOF2'),
  png: (b) => b.length >= 8 && PNG_MAGIC.every((byte, i) => b[i] === byte),
  jpg: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WEBP'),
  avif: (b) => startsWith(b, 4, 'ftypavif'),
}
MAGIC.jpeg = MAGIC.jpg!

export function packageAssetExtension(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1).toLowerCase()
}

/** Zip, gzip, 7z, rar or tar signatures: a package never carries another archive. */
export function looksLikeArchive(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, 0, 'PK\x03\x04') ||
    startsWith(bytes, 0, 'PK\x05\x06') ||
    (bytes[0] === 0x1f && bytes[1] === 0x8b) ||
    startsWith(bytes, 0, '7z\xbc\xaf\x27\x1c') ||
    startsWith(bytes, 0, 'Rar!') ||
    startsWith(bytes, 257, 'ustar')
  )
}

/** NUL and the other control characters, except tab and the line breaks. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true
  }
  return false
}

/** A licence file's text: valid UTF-8 (a leading BOM dropped) without control characters. */
export function decodeLicenseText(
  name: string,
  bytes: Uint8Array,
): { text: string } | { problem: string } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
    if (hasControlCharacter(text)) return { problem: `${name} isn’t plain text` }
    return { text }
  } catch {
    return { problem: `${name} isn’t valid UTF-8 text` }
  }
}

/**
 * The inflated files by their path in the package (`theme.json`, `assets/img/a.png`, …): no archive inside another,
 * every asset really the type its extension says, licence files plain text. Returns the reasons and the licence texts.
 */
export function reviewPackageContent(files: ReadonlyMap<string, Uint8Array>): {
  reasons: string[]
  licenses: Record<string, string>
} {
  const reasons = new Set<string>()
  for (const [name, data] of files) {
    if (looksLikeArchive(data)) {
      reasons.add(`${name}: archives inside a theme package are not allowed`)
      continue
    }
    if (name.startsWith('assets/') && !MAGIC[packageAssetExtension(name)]?.(data))
      reasons.add(`${name}: the file isn’t really a ${packageAssetExtension(name)} file`)
  }
  const licenses: Record<string, string> = {}
  for (const name of THEME_LICENSE_FILES) {
    const bytes = files.get(name)
    if (!bytes) continue
    const decoded = decodeLicenseText(name, bytes)
    if ('problem' in decoded) reasons.add(decoded.problem)
    else licenses[name] = decoded.text
  }
  return { reasons: [...reasons], licenses }
}
