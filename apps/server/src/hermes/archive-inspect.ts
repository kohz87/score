import { constants, closeSync, createReadStream, fstatSync, openSync } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { HttpError } from '../errors.ts'
import { redact } from '../redact.ts'

// Inspection of an exported Hermes profile archive (tar.gz with one top-level directory). Streams the archive,
// never extracts it and never keeps file contents except the two small YAML files read for metadata.
// The path rules mirror what `hermes profile import` enforces (normalize_archive_parts / safe_extract_targz in
// hermes_cli/archive_safe.py): no absolute or `..` paths, only regular files and directories. We refuse the same
// things up front so the person learns why before anything is attempted, and add size and count bounds.

export const MAX_ARCHIVE_ENTRIES = 50_000
export const MAX_UNPACKED_BYTES = 2 * 1024 ** 3
const MAX_RATIO = 200
const MAX_YAML_BYTES = 256 * 1024
const MAX_META_BYTES = 64 * 1024
const LIST_LIMIT = 200

export interface ArchiveFacts {
  root: string
  description: string | null
  model: string | null
  configVersion: string | null
  skills: string[]
  plugins: string[]
  memoryBytes: number
  fileCount: number
  totalBytes: number
  credentialFiles: string[]
  hasBridge: boolean
  warnings: string[]
}

const refuse = (message: string) => new HttpError(400, 'bad_request', message)

/** Same rule as Hermes: backslashes fold to "/", no absolute/drive/`..` parts. Returns the parts or throws. */
export function archiveParts(name: string): string[] {
  const folded = name.replaceAll('\\', '/')
  const parts = folded.split('/').filter((part) => part !== '' && part !== '.')
  if (
    !folded ||
    folded.startsWith('/') ||
    /^[A-Za-z]:/.test(folded) ||
    folded.includes('\0') ||
    parts.length === 0 ||
    parts.includes('..')
  )
    throw refuse('The archive contains an unsafe path, so it was refused.')
  return parts
}

const CREDENTIAL_NAMES = new Set([
  '.env',
  'auth.json',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials.json',
  '.ssh',
  '.gnupg',
  '.aws',
])
function isCredentialName(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower.endsWith('.example')) return false
  return (
    CREDENTIAL_NAMES.has(lower) ||
    lower.startsWith('.env.') ||
    /^id_(rsa|ed25519|ecdsa|dsa)$/.test(lower) ||
    lower.endsWith('.pem')
  )
}

function clean(value: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  return redact(value.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, max)
}
function yamlScalar(raw: string): string | null {
  let value = raw.trim()
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1)
    value = end > 0 ? value.slice(1, end) : value.slice(1)
  } else value = value.replace(/\s+#.*$/, '')
  value = clean(value)
  return value && !['|', '>', '~', 'null'].includes(value) ? value : null
}
/** Line scan for the few fields Score shows; the archive's YAML is never fully parsed. */
export function readModel(text: string): string | null {
  let inModel = false
  for (const line of text.split(/\r?\n/)) {
    const top = /^model:(.*)$/.exec(line)
    if (top) {
      const value = yamlScalar(top[1]!)
      if (value && !value.startsWith('{')) return value
      inModel = true
      continue
    }
    if (!inModel) continue
    if (/^\S/.test(line)) inModel = false
    else {
      const nested = /^\s+(?:default|model):(.*)$/.exec(line)
      if (nested) return yamlScalar(nested[1]!)
    }
  }
  return null
}
function topLevelScalar(text: string, key: string): string | null {
  const match = new RegExp(`^${key}:(.*)$`, 'm').exec(text)
  return match ? yamlScalar(match[1]!) : null
}

class TarScanner {
  private header = Buffer.alloc(512)
  private filled = 0
  private mode: 'header' | 'body' | 'pad' | 'end' = 'header'
  private remaining = 0
  private padding = 0
  private capture: Buffer[] | null = null
  private captureFor: { kind: 'long' | 'pax' | 'config' | 'profile' } | null = null
  private longName: string | undefined
  private paxPath: string | undefined
  private current: { parts: string[]; dir: boolean; size: number } | null = null
  private root: string | undefined
  private readonly seen = new Set<string>()
  private config: string | null = null
  private profile: string | null = null
  private readonly skills = new Set<string>()
  private readonly plugins = new Set<string>()
  private readonly credentials = new Set<string>()
  entries = 0
  files = 0
  total = 0
  memoryBytes = 0
  hasBridge = false
  ended = false
  warnings: string[] = []

  feed(chunk: Buffer): void {
    let at = 0
    while (at < chunk.length) {
      if (this.mode === 'end') return
      if (this.mode === 'header') {
        const take = Math.min(512 - this.filled, chunk.length - at)
        chunk.copy(this.header, this.filled, at, at + take)
        this.filled += take
        at += take
        if (this.filled === 512) {
          this.filled = 0
          this.onHeader()
        }
      } else if (this.mode === 'body') {
        const take = Math.min(this.remaining, chunk.length - at)
        if (this.capture) this.capture.push(Buffer.from(chunk.subarray(at, at + take)))
        this.remaining -= take
        at += take
        if (this.remaining === 0) {
          this.finishBody()
          this.mode = this.padding ? 'pad' : 'header'
        }
      } else {
        const take = Math.min(this.padding, chunk.length - at)
        this.padding -= take
        at += take
        if (this.padding === 0) this.mode = 'header'
      }
    }
  }

  private text(start: number, end: number): string {
    return this.header.subarray(start, end).toString('utf8').split('\0')[0]!
  }

  private onHeader(): void {
    const header = this.header
    if (header.every((byte) => byte === 0)) {
      this.ended = true
      this.mode = 'end'
      return
    }
    const declared = Number.parseInt(this.text(148, 156).trim(), 8)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!
    // GNU base-256 sizes (high bit set) only appear for files over 8 GiB, far past our bound.
    const sizeText = this.text(124, 136).trim() || '0'
    const size = header[124]! & 0x80 ? Number.NaN : Number.parseInt(sizeText, 8)
    if (declared !== sum || !Number.isSafeInteger(size) || size < 0)
      throw refuse('The archive is corrupt.')
    const type = this.text(156, 157) || '0'
    this.padding = (512 - (size % 512)) % 512
    this.remaining = size
    this.capture = null
    this.captureFor = null
    this.current = null

    if (type === 'L' || type === 'x') {
      if (size > MAX_META_BYTES) throw refuse('The archive is corrupt.')
      this.capture = []
      this.captureFor = { kind: type === 'L' ? 'long' : 'pax' }
      this.setBody()
      return
    }
    if (type === 'g' || type === 'K') {
      if (size > MAX_META_BYTES) throw refuse('The archive is corrupt.')
      this.setBody()
      return
    }
    if (!['0', '7', '5'].includes(type))
      throw refuse(
        'The archive contains links, devices or special files, which Hermes refuses to import.',
      )
    const ustar = header.subarray(257, 263).toString() === 'ustar\0'
    const name =
      this.longName ??
      this.paxPath ??
      [ustar ? this.text(345, 500) : '', this.text(0, 100)].filter(Boolean).join('/')
    this.longName = undefined
    this.paxPath = undefined
    const parts = archiveParts(name)
    const dir = type === '5'
    if (dir && size) throw refuse('The archive is corrupt.')
    if (++this.entries > MAX_ARCHIVE_ENTRIES)
      throw refuse(`The archive has more than ${MAX_ARCHIVE_ENTRIES} entries.`)
    if (parts.length === 1 && !dir)
      throw refuse('The archive must contain exactly one top-level directory.')
    this.root ??= parts[0]
    if (parts[0] !== this.root)
      throw refuse('The archive must contain exactly one top-level directory.')
    this.total += size
    if (this.total > MAX_UNPACKED_BYTES) throw refuse('The archive unpacks to too much data.')
    this.current = { parts: parts.slice(1), dir, size }
    this.classify(this.current)
    this.setBody()
  }

  private setBody(): void {
    this.mode = this.remaining ? 'body' : this.padding ? 'pad' : 'header'
    if (!this.remaining) this.finishBody()
  }

  private classify(entry: { parts: string[]; dir: boolean; size: number }): void {
    const rel = entry.parts
    const key = rel.join('/')
    if (key && this.seen.has(key)) return
    if (key) this.seen.add(key)
    if (!entry.dir) this.files++
    for (const part of rel)
      if (isCredentialName(part)) {
        if (this.credentials.size < LIST_LIMIT) this.credentials.add(clean(key, 300))
        break
      }
    if (entry.dir || !rel.length) {
      if (rel[0] === 'plugins' && rel.length === 2 && !rel[1]!.startsWith('.'))
        this.plugins.add(clean(rel[1]!, 100))
      return
    }
    if (rel.length === 1 && (rel[0] === 'config.yaml' || rel[0] === 'profile.yaml')) {
      if (entry.size <= MAX_YAML_BYTES) {
        this.capture = []
        this.captureFor = { kind: rel[0] === 'config.yaml' ? 'config' : 'profile' }
      } else this.warnings.push(`${rel[0]} is unusually large and was not read.`)
    } else if (rel[0] === 'skills' && rel.length >= 3 && rel[rel.length - 1] === 'SKILL.md') {
      if (this.skills.size < LIST_LIMIT) this.skills.add(clean(rel.slice(1, -1).join('/'), 100))
    } else if (rel[0] === 'plugins' && rel.length >= 3 && !rel[1]!.startsWith('.')) {
      this.plugins.add(clean(rel[1]!, 100))
    } else if (rel[0] === 'memories') this.memoryBytes += entry.size
    if (rel[0] === 'plugins' && ['score-bridge', 'score_bridge'].includes(rel[1] ?? ''))
      this.hasBridge = true
  }

  private finishBody(): void {
    const kind = this.captureFor?.kind
    if (!kind || !this.capture) return
    const bytes = Buffer.concat(this.capture)
    this.capture = null
    const text = bytes.toString('utf8')
    if (kind === 'long') this.longName = text.split('\0')[0]
    else if (kind === 'pax') {
      // "<len> path=<name>\n" records; only the path matters for the checks.
      for (const record of text.split('\n')) {
        const match = /^\d+ path=(.*)$/.exec(record)
        if (match) this.paxPath = match[1]
      }
    } else if (kind === 'config') this.config = text
    else this.profile = text
  }

  result(): ArchiveFacts {
    if (!this.ended || !this.root) throw refuse('The archive is incomplete or empty.')
    const facts: ArchiveFacts = {
      root: this.root,
      description: this.profile ? topLevelScalar(this.profile, 'description') : null,
      model: this.config ? readModel(this.config) : null,
      configVersion: this.config ? topLevelScalar(this.config, '_config_version') : null,
      skills: [...this.skills].sort(),
      plugins: [...this.plugins].sort(),
      memoryBytes: this.memoryBytes,
      fileCount: this.files,
      totalBytes: this.total,
      credentialFiles: [...this.credentials].sort(),
      hasBridge: this.hasBridge,
      warnings: [...this.warnings],
    }
    return facts
  }
}

/** Inspects the archive at `path` (a file Score itself stored). Throws HttpError 400 when it is unsafe or not a profile archive. */
export async function inspectProfileArchive(path: string, maxBytes: number): Promise<ArchiveFacts> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let handedOver = false
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > maxBytes) throw refuse('The archive is missing or too large.')
    const scanner = new TarScanner()
    const gunzip = createGunzip()
    const source = createReadStream(path, { fd, autoClose: true })
    handedOver = true
    source.on('error', (error) => gunzip.destroy(error))
    source.pipe(gunzip)
    let unpacked = 0
    try {
      for await (const chunk of gunzip as AsyncIterable<Buffer>) {
        unpacked += chunk.length
        // Zip-bomb guard on top of the unpacked-size bound, so a tiny file cannot burn minutes of CPU.
        if (unpacked > info.size * MAX_RATIO + 16 * 1024 * 1024)
          throw refuse('The archive expands far more than a real export would.')
        scanner.feed(chunk)
        if (scanner.ended) break
      }
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw refuse('The file is not a valid .tar.gz archive.')
    } finally {
      source.destroy()
      gunzip.destroy()
    }
    const facts = scanner.result()
    if (facts.credentialFiles.length)
      facts.warnings.push(
        'The archive contains credential files. Hermes copies them into the new agent; their contents are not shown.',
      )
    if (facts.plugins.length)
      facts.warnings.push(
        'Imported plugins run code on this machine. Import only archives you trust.',
      )
    return facts
  } finally {
    if (!handedOver) closeSync(fd)
  }
}
