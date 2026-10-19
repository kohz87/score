import {
  PetActivitySchema,
  PetPackManifestSchema,
  ThemePackageError,
  readZipDirectory,
  tooWellCompressed,
  type PetActivity,
  type PetPackManifest,
  type ZipEntryInfo,
} from '@score/contract'
import { ThemeRejected, inflate } from '../themes/package.ts'
import { PACK_EXTENSIONS, PACK_IMAGE_MAX_BYTES, sniffPackImage, type PackExt } from './sniff.ts'

// Reads an uploaded pet pack (PLAN 10.2, decisions 107-108): one zip, or several activity files. The zip's structure
// goes through the shared zip rules of the contract package (`readZipDirectory`: headers against each other, names,
// extra fields, symlink metadata, overlapping data; the ratio check and the inflating are the theme reader's), then
// the pack's own layout, caps and image checks. Nothing in a pack is run, and nothing is stored here.

export const PACK_LIMITS = {
  /** Files in the upload (a zip's folders are not counted). */
  files: 24,
  unpackedBytes: 256 * 1024 * 1024,
  manifestBytes: 64 * 1024,
} as const

export class PackRejected extends Error {
  constructor(readonly reasons: string[]) {
    super(reasons.join('; '))
  }
}

export interface ReadPack {
  /** One file per activity, in the contract's order. */
  files: { activity: PetActivity; ext: PackExt; bytes: Buffer }[]
  manifest: PetPackManifest
  /** Paths that were not part of the pack and were left out, as the person named them. */
  ignored: string[]
}

const ACTIVITIES = PetActivitySchema.options
const IMAGE_LIKE = new Set([
  'webp',
  'png',
  'gif',
  'jpg',
  'jpeg',
  'apng',
  'avif',
  'bmp',
  'svg',
  'tif',
  'tiff',
  'heic',
])
const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])
const shown = (path: string) => path.replaceAll('\\', '/').slice(0, 120)

function pathProblem(raw: string): string | null {
  if (raw.includes('\\')) return 'backslash in the path'
  if (raw.includes('\0')) return 'unsafe path'
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return 'absolute path'
  const segments = raw.replace(/\/$/, '').split('/')
  if (segments.some((segment) => segment === '..')) return 'path leaves the folder'
  if (segments.some((segment) => segment === '' || segment === '.')) return 'unsafe path'
  return null
}

interface Candidate {
  path: string
  /** What the pack gets from this file, once it is known to be wanted. */
  size: number
  packed: number
  read: (cap: number) => Buffer
}

type Kind =
  | { kind: 'ignored' }
  | { kind: 'manifest' }
  | { kind: 'image'; activity: PetActivity; ext: PackExt }
  | { kind: 'rejected'; reason: string }

function isJunk(path: string): boolean {
  const segments = path.split('/')
  const base = segments[segments.length - 1]!.toLowerCase()
  return segments[0] === '__MACOSX' || JUNK_NAMES.has(base) || base.startsWith('._')
}

function classify(path: string, folder: string | null): Kind {
  if (isJunk(path)) return { kind: 'ignored' }
  // Files outside the pack's own folder (a README beside it) are not part of the pack.
  if (folder !== null && !path.startsWith(`${folder}/`)) return { kind: 'ignored' }
  const relative = folder === null ? path : path.slice(folder.length + 1)
  // A pack is flat: files deeper than its one folder are not part of it.
  if (relative.includes('/')) return { kind: 'ignored' }
  const lower = relative.toLowerCase()
  if (lower === 'pet.json') return { kind: 'manifest' }
  const match = /^(.+)\.([a-z0-9]+)$/.exec(lower)
  if (!match || !IMAGE_LIKE.has(match[2]!)) return { kind: 'ignored' }
  const [, stem, ext] = match as unknown as [string, string, string]
  const activity = ACTIVITIES.find((name) => name === stem)
  if (!activity)
    return {
      kind: 'rejected',
      reason: `${shown(relative)}: “${stem}” isn’t an activity name. Name files ${ACTIVITIES.join(', ')} (plus pet.json).`,
    }
  if (!(PACK_EXTENSIONS as readonly string[]).includes(ext))
    return {
      kind: 'rejected',
      reason: `${shown(relative)}: use .webp, .png or .gif for ${activity}.`,
    }
  return { kind: 'image', activity, ext: ext as PackExt }
}

/** True for what marks a place as the pack: pet.json, or an image named after an activity. */
function marksPack(base: string): boolean {
  const lower = base.toLowerCase()
  if (lower === 'pet.json') return true
  const match = /^(.+)\.([a-z0-9]+)$/.exec(lower)
  return match !== null && IMAGE_LIKE.has(match[2]!) && ACTIVITIES.some((name) => name === match[1])
}

/**
 * The folder the pack lives in, chosen by where its activity images and pet.json are, not by every file in the zip:
 * none when any of them is at the top level (those win, files in folders are ignored); else the one top-level folder
 * that holds them; none when several folders do.
 */
function topFolder(paths: string[]): string | null {
  const marked = paths.filter((path) => !isJunk(path) && marksPack(path.split('/').pop()!))
  if (marked.some((path) => !path.includes('/'))) return null
  const folders = new Set(
    marked.filter((path) => path.split('/').length === 2).map((path) => path.split('/')[0]!),
  )
  const [only] = [...folders]
  return folders.size === 1 && only !== undefined ? only : null
}

function manifestOf(bytes: Buffer, reasons: string[]): PetPackManifest {
  if (bytes.length > PACK_LIMITS.manifestBytes) {
    reasons.push('pet.json: larger than 64 KB.')
    return {}
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    reasons.push('pet.json: isn’t valid JSON text.')
    return {}
  }
  const parsed = PetPackManifestSchema.safeParse(value)
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 5))
      reasons.push(`pet.json: ${issue.path.join('.') || 'file'}: ${issue.message}`)
    return {}
  }
  return parsed.data
}

function zipCandidates(name: string, bytes: Buffer): Candidate[] {
  if (bytes.length < 4 || bytes.toString('latin1', 0, 4) !== 'PK\x03\x04')
    throw new PackRejected([`${shown(name)} isn’t a zip file.`])
  let listed: ZipEntryInfo[]
  try {
    listed = readZipDirectory(bytes)
  } catch (error) {
    if (error instanceof ThemePackageError)
      throw new PackRejected([`${shown(name)}: ${error.message}`])
    throw error
  }
  const reasons = new Set<string>()
  const candidates: Candidate[] = []
  for (const entry of listed) {
    const problem = pathProblem(entry.name)
    if (problem) {
      reasons.add(`${shown(entry.name)}: ${problem}`)
      continue
    }
    if (entry.unixMode !== null && (entry.unixMode & 0o170000) === 0o120000) {
      reasons.add(`${shown(entry.name)}: symbolic links are not allowed`)
      continue
    }
    if (entry.isDir) continue
    candidates.push({
      path: entry.name,
      size: entry.size,
      packed: entry.packed,
      read: (cap) => {
        try {
          return inflate(bytes, entry, cap)
        } catch (error) {
          if (error instanceof ThemeRejected) throw new PackRejected(error.reasons)
          throw error
        }
      },
    })
  }
  if (reasons.size > 0) throw new PackRejected([...reasons])
  return candidates
}

/**
 * Reads the upload: `files` are the parts of the request as `{ name, bytes }`. Throws `PackRejected` with every reason
 * found, and stores nothing.
 */
export function readPack(files: { name: string; bytes: Buffer }[]): ReadPack {
  const zips = files.filter(
    (file) => /\.zip$/i.test(file.name) || file.bytes.toString('latin1', 0, 4) === 'PK\x03\x04',
  )
  if (zips.length > 0 && files.length > 1)
    throw new PackRejected(['Send either one zip or several image files, not both.'])
  const candidates: Candidate[] =
    zips.length === 1
      ? zipCandidates(zips[0]!.name, zips[0]!.bytes)
      : files.map((file) => ({
          path: file.name,
          size: file.bytes.length,
          packed: file.bytes.length,
          read: () => file.bytes,
        }))
  if (candidates.length > PACK_LIMITS.files)
    throw new PackRejected([`The pack holds more than ${PACK_LIMITS.files} files.`])

  const folder = topFolder(candidates.map((candidate) => candidate.path))
  const reasons: string[] = []
  const ignored: string[] = []
  const wanted: {
    candidate: Candidate
    kind: Exclude<Kind, { kind: 'ignored' } | { kind: 'rejected' }>
  }[] = []
  const seen = new Map<string, string>()
  for (const candidate of candidates) {
    const kind = classify(candidate.path, folder)
    if (kind.kind === 'ignored') ignored.push(shown(candidate.path))
    else if (kind.kind === 'rejected') reasons.push(kind.reason)
    else {
      const key = kind.kind === 'manifest' ? 'pet.json' : kind.activity
      const before = seen.get(key)
      if (before !== undefined)
        reasons.push(
          kind.kind === 'manifest'
            ? 'pet.json appears twice.'
            : `${before} and ${shown(candidate.path)}: one file per activity (${kind.activity}).`,
        )
      else seen.set(key, shown(candidate.path))
      wanted.push({ candidate, kind })
    }
  }
  if (!wanted.some(({ kind }) => kind.kind === 'image' && kind.activity === 'idle'))
    reasons.push(
      'idle is missing. Every pack needs an idle animation (idle.webp, idle.png or idle.gif).',
    )

  // Declared sizes first (a zip says them before anything is inflated), then the real bytes.
  let declared = 0
  for (const { candidate, kind } of wanted) {
    const cap = kind.kind === 'image' ? PACK_IMAGE_MAX_BYTES : PACK_LIMITS.manifestBytes
    if (candidate.size > cap) {
      reasons.push(
        kind.kind === 'image'
          ? `${shown(candidate.path)}: larger than 32 MB.`
          : 'pet.json: larger than 64 KB.',
      )
    }
    if (tooWellCompressed(candidate.size, candidate.packed))
      throw new PackRejected([
        `${shown(candidate.path)}: compresses suspiciously well (a zip bomb?), so the pack isn’t read.`,
      ])
    declared += candidate.size
  }
  if (declared > PACK_LIMITS.unpackedBytes)
    reasons.push(`The pack is more than ${PACK_LIMITS.unpackedBytes / 1024 / 1024} MB unpacked.`)
  if (reasons.length > 0) throw new PackRejected(reasons)

  const images: ReadPack['files'] = []
  let manifest: PetPackManifest = {}
  for (const { candidate, kind } of wanted) {
    const bytes = candidate.read(
      kind.kind === 'image' ? PACK_IMAGE_MAX_BYTES : PACK_LIMITS.manifestBytes,
    )
    if (kind.kind === 'manifest') {
      manifest = manifestOf(bytes, reasons)
      continue
    }
    const sniff = sniffPackImage(bytes, candidate.path)
    if (!sniff.ok)
      for (const reason of sniff.reasons) reasons.push(`${shown(candidate.path)}: ${reason}`)
    else images.push({ activity: kind.activity, ext: sniff.ext, bytes })
  }
  if (reasons.length > 0) throw new PackRejected(reasons)
  images.sort((a, b) => ACTIVITIES.indexOf(a.activity) - ACTIVITIES.indexOf(b.activity))
  return { files: images, manifest, ignored: ignored.sort() }
}
