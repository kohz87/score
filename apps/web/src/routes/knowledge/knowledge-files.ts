import {
  KnowledgeDocumentSchema,
  KnowledgeUnzipResultSchema,
  KnowledgeUploadResultSchema,
  KnowledgeZipPreviewSchema,
  type KnowledgeDocumentType,
} from '@score/contract'
import { apiFetch, apiUpload, type UploadProgress } from '../../data/api.ts'
import { notePath } from './knowledge-paths.ts'

// Client side of Knowledge files (PLAN 6.6). The server decides from the bytes; these checks only spare an obviously
// unsupported or oversized file the trip.

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
export const ACCEPT_FILES = [
  '.md',
  '.markdown',
  '.txt',
  '.pdf',
  '.docx',
  '.csv',
  '.json',
  '.html',
  '.htm',
  '.zip',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
].join(',')
const SUPPORTED = new Set(ACCEPT_FILES.replaceAll('.', '').split(','))

export const extensionOf = (name: string): string =>
  /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? ''
export const isNotePath = (path: string) => /\.md$/i.test(path)
export const isZipName = (name: string) => extensionOf(name) === 'zip'
export const isSupportedName = (name: string) => SUPPORTED.has(extensionOf(name))

/** Why a file will not be uploaded, or null. */
export function uploadProblem(file: { name: string; size: number }): string | null {
  if (!isSupportedName(file.name))
    return `${file.name}: this file type isn’t supported. Use notes, PDF, DOCX, CSV, JSON, HTML, images or zip files`
  if (file.size === 0) return `${file.name}: the file is empty`
  if (file.size > MAX_UPLOAD_BYTES) return `${file.name}: larger than the 25 MB limit`
  return null
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export const TYPE_LABEL: Record<KnowledgeDocumentType | 'note', string> = {
  note: 'Note',
  pdf: 'PDF',
  docx: 'DOCX',
  csv: 'CSV',
  json: 'JSON',
  html: 'HTML',
  image: 'Image',
  zip: 'Zip',
}

export const documentApi = (path: string) => `knowledge/documents/${notePath(path)}`
export const fileHref = (path: string, download = false) =>
  `/api/knowledge/files/${notePath(path)}${download ? '?download=1' : ''}`
const uploadApi = (path: string, query: Record<string, string>) =>
  `knowledge/files/${notePath(path)}?${new URLSearchParams(query)}`

export type OnConflict = 'ask' | 'keep' | 'replace'

export async function fetchDocument(path: string, signal?: AbortSignal) {
  return KnowledgeDocumentSchema.parse(await apiFetch(documentApi(path), signal ? { signal } : {}))
}

// Uploads go through apiUpload so the person sees how much has been sent (a 24 MB zip took minutes in silence).
export async function uploadBlob(
  path: string,
  blob: Blob,
  onConflict: OnConflict,
  extra: Record<string, string> = {},
  onProgress?: (progress: UploadProgress) => void,
) {
  return KnowledgeUploadResultSchema.parse(
    await apiUpload(uploadApi(path, { onConflict, ...extra }), blob, onProgress),
  )
}

export async function previewZip(
  path: string,
  blob: Blob,
  onProgress?: (progress: UploadProgress) => void,
) {
  return KnowledgeZipPreviewSchema.parse(
    await apiUpload(uploadApi(path, { mode: 'preview' }), blob, onProgress),
  )
}

export async function unzipBlob(
  path: string,
  blob: Blob,
  folder: string,
  onConflict: OnConflict,
  onProgress?: (progress: UploadProgress) => void,
) {
  return KnowledgeUnzipResultSchema.parse(
    await apiUpload(uploadApi(path, { mode: 'unzip', folder, onConflict }), blob, onProgress),
  )
}

export async function saveMedia(mediaId: string, path: string, onConflict: OnConflict) {
  return KnowledgeUploadResultSchema.parse(
    await apiFetch('knowledge/files-from-media', {
      method: 'POST',
      body: JSON.stringify({ mediaId, path, onConflict }),
    }),
  )
}

/** `details.existing` of a 409 `exists`. */
export function existingOf(details: unknown): Array<{ path: string; mtime: string; size: number }> {
  if (typeof details !== 'object' || details === null) return []
  const list = (details as { existing?: unknown }).existing
  if (!Array.isArray(list)) return []
  return list.flatMap((item): Array<{ path: string; mtime: string; size: number }> => {
    const entry = item as Record<string, unknown>
    return typeof entry.path === 'string' && typeof entry.mtime === 'string'
      ? [
          {
            path: entry.path,
            mtime: entry.mtime,
            size: typeof entry.size === 'number' ? entry.size : 0,
          },
        ]
      : []
  })
}

export const joinPath = (folder: string, name: string) =>
  folder === '' ? name : `${folder.replace(/\/+$/, '')}/${name}`
