import { Buffer } from 'node:buffer'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { parentPort, workerData } from 'node:worker_threads'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { extractText, getDocumentProxy } from 'unpdf'
import { classifyName, MAX_FILE_BYTES } from './doc-types.ts'
import type { WorkerRequest, WorkerResult, ZipItem, ZipLimits } from './extract-types.ts'

// Runs inside a worker thread with a heap limit and a wall-clock limit set by the host (extract.ts): PDF, DOCX and
// HTML parsing and zip inflation never run on the server's main thread. Pure input -> output, no vault access.

function cutText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  const cut = new TextDecoder('utf-8').decode(Buffer.from(text).subarray(0, maxBytes))
  return { text: cut.replace(/�+$/, ''), truncated: true }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}
function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|br|section|article|table)\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
      if (name[0] === '#') {
        const code =
          name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
        return Number.isInteger(code) &&
          code > 0 &&
          code < 0x110000 &&
          !(code >= 0xd800 && code < 0xe000)
          ? String.fromCodePoint(code)
          : ' '
      }
      return ENTITIES[name.toLowerCase()] ?? match
    })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes))
  const { text } = await extractText(pdf, { mergePages: true })
  return text
}

// ---- zip ------------------------------------------------------------------------------------------------------

class ZipLimitError extends Error {}

/** Entry count from the end-of-central-directory record, before JSZip allocates anything for the entries. */
function declaredEntryCount(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1)
    if (view.getUint32(at, true) === 0x06054b50) return view.getUint16(at + 10, true)
  return 0
}

/** `..`, absolute, drive-letter, hidden and `.git` entries are refused; `a//b` and `./a` are normalised. */
function zipEntryPath(raw: string): { path: string } | { skip: string } {
  const name = raw.replaceAll('\\', '/')
  if (name.includes('\0')) return { skip: 'unsafe path' }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return { skip: 'absolute path' }
  const segments: string[] = []
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return { skip: 'path leaves the folder' }
    if (segment === '__MACOSX') return { skip: 'macOS metadata' }
    if (segment.startsWith('.')) return { skip: 'hidden file' }
    if (Buffer.byteLength(segment) > 200) return { skip: 'name too long' }
    segments.push(segment)
  }
  if (segments.length === 0) return { skip: 'no name' }
  if (segments.length > 16) return { skip: 'folders nested too deeply' }
  return { path: segments.join('/') }
}

interface InternalData {
  uncompressedSize?: number
  compressedSize?: number
}

// jszip exposes the sizes it read from the central directory only through this internal field; they are untrusted
// (a zip can lie), so inflation below also counts the real bytes.
function sizesOf(file: JSZip.JSZipObject): { size: number | null; packed: number | null } {
  const data = (file as unknown as { _data?: InternalData })._data
  return {
    size: typeof data?.uncompressedSize === 'number' ? data.uncompressedSize : null,
    packed: typeof data?.compressedSize === 'number' ? data.compressedSize : null,
  }
}

function symlink(file: JSZip.JSZipObject): boolean {
  const mode = file.unixPermissions
  return typeof mode === 'number' && (mode & 0o170000) === 0o120000
}

async function openZip(bytes: Uint8Array, limits: ZipLimits): Promise<JSZip> {
  if (declaredEntryCount(bytes) > limits.maxEntries)
    throw new ZipLimitError(`The zip holds more than ${limits.maxEntries} entries`)
  const zip = await JSZip.loadAsync(bytes, { createFolders: false })
  if (Object.keys(zip.files).length > limits.maxEntries)
    throw new ZipLimitError(`The zip holds more than ${limits.maxEntries} entries`)
  return zip
}

interface Plan {
  file: JSZip.JSZipObject
  path: string
  size: number | null
  packed: number | null
}

function plan(zip: JSZip, limits: ZipLimits) {
  const items: Array<ZipItem & { entry?: Plan }> = []
  const seen = new Set<string>()
  let declaredTotal = 0
  for (const [sanitisedName, file] of Object.entries(zip.files)) {
    if (file.dir) continue
    // jszip strips `..` from `name`; the name as stored in the archive is what must be judged.
    const rawName =
      (file as unknown as { unsafeOriginalName?: string }).unsafeOriginalName ?? sanitisedName
    const display = rawName.replaceAll('\\', '/').slice(0, 300)
    if (symlink(file)) {
      items.push({ path: display, size: 0, action: 'skip', reason: 'symbolic link' })
      continue
    }
    const clean = zipEntryPath(rawName)
    if ('skip' in clean) {
      items.push({ path: display, size: 0, action: 'skip', reason: clean.skip })
      continue
    }
    const { size, packed } = sizesOf(file)
    const cls = classifyName(clean.path.split('/').pop()!)
    if (!cls) {
      items.push({
        path: clean.path,
        size: size ?? 0,
        action: 'skip',
        reason: 'type not supported',
      })
      continue
    }
    if (seen.has(clean.path.toLowerCase())) {
      items.push({ path: clean.path, size: size ?? 0, action: 'skip', reason: 'duplicate name' })
      continue
    }
    const cap = cls.kind === 'note' ? limits.maxNoteBytes : MAX_FILE_BYTES
    if (size !== null && size > cap) {
      items.push({ path: clean.path, size, action: 'skip', reason: 'file too large' })
      continue
    }
    if (
      size !== null &&
      size > limits.ratioFloorBytes &&
      size > limits.maxRatio * Math.max(packed ?? 1, 1)
    )
      throw new ZipLimitError('The zip compresses suspiciously well (zip bomb?)')
    declaredTotal += size ?? 0
    if (declaredTotal > limits.maxTotalBytes)
      throw new ZipLimitError(
        `The zip would unpack to more than ${limits.maxTotalBytes / 1024 / 1024} MB`,
      )
    seen.add(clean.path.toLowerCase())
    items.push({
      path: clean.path,
      size: size ?? 0,
      action: 'extract',
      reason: null,
      entry: { file, path: clean.path, size, packed },
    })
  }
  return items
}

function inflate(entry: Plan, cap: number, limits: ZipLimits): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    const stream = entry.file.nodeStream('nodebuffer') as unknown as Readable
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > cap || (entry.size !== null && total > entry.size)) {
        stream.destroy()
        reject(new ZipLimitError(`${entry.path} is larger than the zip says it is`))
        return
      }
      if (
        total > limits.ratioFloorBytes &&
        total > limits.maxRatio * Math.max(entry.packed ?? 1, 1)
      ) {
        stream.destroy()
        reject(new ZipLimitError('The zip compresses suspiciously well (zip bomb?)'))
        return
      }
      chunks.push(chunk)
    })
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

async function zipList(bytes: Uint8Array, limits: ZipLimits): Promise<WorkerResult> {
  const zip = await openZip(bytes, limits)
  const all = plan(zip, limits).map((item) => ({
    path: item.path,
    size: item.size,
    action: item.action,
    reason: item.reason,
  }))
  return {
    ok: true,
    entries: all.slice(0, limits.maxEntries),
    more: all.length > limits.maxEntries,
  }
}

async function zipExtract(
  bytes: Uint8Array,
  outDir: string,
  limits: ZipLimits,
): Promise<WorkerResult> {
  const zip = await openZip(bytes, limits)
  const items = plan(zip, limits)
  await mkdir(outDir, { recursive: true })
  const files: Array<{ path: string; size: number; file: string }> = []
  const skipped: Array<{ path: string; reason: string }> = []
  let total = 0
  for (const item of items) {
    if (item.action === 'skip' || !item.entry) {
      skipped.push({ path: item.path, reason: item.reason ?? 'skipped' })
      continue
    }
    const cap =
      classifyName(item.path.split('/').pop()!)?.kind === 'note'
        ? limits.maxNoteBytes
        : MAX_FILE_BYTES
    const data = await inflate(item.entry, cap, limits)
    total += data.length
    if (total > limits.maxTotalBytes)
      throw new ZipLimitError(
        `The zip would unpack to more than ${limits.maxTotalBytes / 1024 / 1024} MB`,
      )
    const file = path.join(outDir, `${files.length}.bin`)
    await writeFile(file, data)
    files.push({ path: item.path, size: data.length, file })
  }
  return { ok: true, files, skipped }
}

async function handle(request: WorkerRequest): Promise<WorkerResult> {
  switch (request.op) {
    case 'text': {
      const bytes = request.bytes
      let text: string
      if (request.kind === 'pdf') text = await pdfText(bytes)
      else if (request.kind === 'docx')
        text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value
      else text = htmlToText(Buffer.from(bytes).toString('utf8'))
      return { ok: true, ...cutText(text, request.maxBytes) }
    }
    case 'zip-list':
      return zipList(request.bytes, request.limits)
    case 'zip-extract':
      return zipExtract(request.bytes, request.outDir, request.limits)
  }
}

const request = workerData as WorkerRequest
handle(request).then(
  (result) => parentPort?.postMessage(result),
  (error: unknown) =>
    parentPort?.postMessage({
      ok: false,
      limit: error instanceof ZipLimitError,
      message: error instanceof Error ? error.message : 'extraction failed',
    } satisfies WorkerResult),
)
