import { constants as C } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import JSZip from 'jszip'
import type { KnowledgeExportRequest, KnowledgeExportSummary, KnowledgeTree } from '@score/contract'
import { HttpError } from '../errors.ts'
import { parseVaultPath } from './note.ts'

// Knowledge export (PLAN 6.7, contract §12). The file set comes from the index (notes and documents), the bytes
// straight from disk: nothing of Score's own state (git, extracted text, the DB) ever goes into an archive.

export const MAX_EXPORT_FILES = 10_000
export const MAX_EXPORT_BYTES = 1024 * 1024 * 1024
export const EXPORT_TIMEOUT_MS = 10 * 60 * 1000

export interface ExportFile {
  /** Path relative to the vault. */
  path: string
  /** Name inside the archive. */
  entry: string
  size: number
}

export interface ExportPlan {
  files: ExportFile[]
  bytes: number
  label: KnowledgeExportSummary['label']
  /** Used in the download's file name. */
  name: string
}

const hasDotSegment = (rel: string) => rel.split('/').some((segment) => segment.startsWith('.'))
// Already compressed: deflating again only costs CPU.
const STORED = /\.(pdf|docx|zip|png|jpe?g|gif|webp)$/i

/** The vault paths that may be exported: indexed notes and documents, never hidden or `.git` content. */
export function exportCandidates(tree: KnowledgeTree): string[] {
  return [...tree.notes.map((note) => note.path), ...tree.documents.map((doc) => doc.path)]
    .filter((rel) => !hasDotSegment(rel))
    .sort()
}

/** Regular files only (no symlinks, no directories); a file that vanished is left out. */
async function regularSize(root: string, rel: string): Promise<number | null> {
  try {
    const stat = await fs.lstat(path.join(root, ...rel.split('/')))
    return stat.isFile() ? stat.size : null
  } catch {
    return null
  }
}

export async function planExport(
  root: string,
  candidates: string[],
  request: KnowledgeExportRequest,
): Promise<ExportPlan> {
  let chosen: { path: string; entry: string }[]
  let label: ExportPlan['label']
  let name: string
  if (request.all) {
    label = 'vault'
    name = 'vault'
    chosen = candidates.map((rel) => ({ path: rel, entry: rel }))
  } else if (request.folder !== undefined) {
    label = 'folder'
    const folder = parseVaultPath(request.folder).join('/')
    if (hasDotSegment(folder)) throw new HttpError(400, 'bad_path', 'That folder isn’t available.')
    name = folder.split('/').pop()!
    chosen = candidates
      .filter((rel) => rel.startsWith(`${folder}/`))
      .map((rel) => ({ path: rel, entry: rel.slice(folder.length + 1) }))
    if (chosen.length === 0) {
      const exists = await fs
        .lstat(path.join(root, ...folder.split('/')))
        .then((stat) => stat.isDirectory())
        .catch(() => false)
      if (!exists) throw new HttpError(404, 'not_found', 'Couldn’t find that folder.')
    }
  } else {
    label = 'selection'
    name = 'selection'
    const known = new Set(candidates)
    const seen = new Set<string>()
    chosen = []
    for (const input of request.paths ?? []) {
      const rel = parseVaultPath(input).join('/')
      if (!known.has(rel)) throw new HttpError(404, 'not_found', `Couldn’t find the file ${rel}.`)
      if (seen.has(rel)) continue
      seen.add(rel)
      chosen.push({ path: rel, entry: rel })
    }
  }
  if (chosen.length > MAX_EXPORT_FILES)
    throw new HttpError(413, 'export_too_large', 'That is too many files to export at once.', {
      files: chosen.length,
      bytes: 0,
    })
  const files: ExportFile[] = []
  let bytes = 0
  for (const item of chosen) {
    const size = await regularSize(root, item.path)
    if (size === null) continue
    files.push({ ...item, size })
    bytes += size
  }
  if (files.length === 0) throw new HttpError(400, 'bad_request', 'There is nothing to export.')
  if (bytes > MAX_EXPORT_BYTES)
    throw new HttpError(413, 'export_too_large', 'That is too large to export at once (1 GB).', {
      files: files.length,
      bytes,
    })
  return { files, bytes, label, name }
}

export const exportSummary = (plan: ExportPlan): KnowledgeExportSummary => ({
  files: plan.files.length,
  bytes: plan.bytes,
  label: plan.label,
})

export function exportFileName(plan: ExportPlan, now: Date): string {
  const safe = plan.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  const middle = plan.label === 'folder' ? safe || 'folder' : plan.name
  return `knowledge-${middle}-${now.toISOString().slice(0, 10)}.zip`
}

// Opened lazily (one handle at a time) and without following a symlink: a file swapped for a link after planning
// must fail the export, not leak whatever it points at.
function readNoFollow(abs: string): Readable {
  return Readable.from(
    (async function* () {
      const handle = await fs.open(abs, C.O_RDONLY | C.O_NOFOLLOW)
      try {
        yield* handle.createReadStream({ autoClose: false })
      } finally {
        await handle.close()
      }
    })(),
    { objectMode: false },
  )
}

/** The archive as a stream; files are read from disk one chunk at a time, so memory stays bounded. */
export function exportStream(root: string, plan: ExportPlan, now: Date): Readable {
  const zip = new JSZip()
  zip.file(
    'README.txt',
    `Exported from Score Knowledge on ${now.toISOString()}: ${plan.files.length} files. Notes are Markdown, documents are the original files.\n`,
    { date: now },
  )
  for (const file of plan.files) {
    const stream = readNoFollow(path.join(root, ...file.path.split('/')))
    zip.file(file.entry, stream, {
      binary: true,
      createFolders: false,
      date: now,
      compression: STORED.test(file.entry) ? 'STORE' : 'DEFLATE',
      compressionOptions: { level: 6 },
    })
  }
  return zip.generateNodeStream({ streamFiles: true, type: 'nodebuffer' }) as unknown as Readable
}
