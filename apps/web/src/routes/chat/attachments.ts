import type { Message, MessagePart } from '@score/contract'

export const MAX_ATTACHMENTS = 10
export const MAX_FILE_BYTES = 25 * 1024 * 1024
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** What the file picker offers; the server decides from the bytes. */
export const ACCEPT = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  '.pdf',
  '.docx',
  '.xlsx',
  '.csv',
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.html',
  '.htm',
].join(',')

/** An upload (`/api/media`) or a reference to a file in an agent's workspace. */
export type Attachment =
  | { kind: 'upload'; mediaId: string; name: string; contentType: string; size: number }
  | { kind: 'workspace'; agentId: string; path: string }

export const attachmentKey = (item: Attachment): string =>
  item.kind === 'upload' ? item.mediaId : `workspace:${item.agentId}:${item.path}`
export const attachmentName = (item: Attachment): string =>
  item.kind === 'upload' ? item.name : (item.path.split('/').pop() ?? item.path)
export const isImage = (contentType: string): boolean => contentType.startsWith('image/')

export function parseUpload(value: unknown): Extract<Attachment, { kind: 'upload' }> {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  if (typeof record.mediaId !== 'string' || !record.mediaId) throw new Error('Bad upload response')
  return {
    kind: 'upload',
    mediaId: record.mediaId,
    name: typeof record.name === 'string' ? record.name : 'file',
    contentType:
      typeof record.contentType === 'string' ? record.contentType : 'application/octet-stream',
    size: typeof record.size === 'number' ? record.size : 0,
  }
}

/** The `attachments` entries of `POST /api/rooms/:roomId/messages`. */
export const toRequest = (item: Attachment) =>
  item.kind === 'upload'
    ? { mediaId: item.mediaId, name: item.name }
    : { workspace: { agentId: item.agentId, path: item.path } }

/** The part the message shows while its send is still in flight. */
export function toPart(item: Attachment): MessagePart {
  if (item.kind === 'workspace')
    return { kind: 'workspace', agentId: item.agentId, path: item.path }
  if (isImage(item.contentType)) return { kind: 'image', mediaId: item.mediaId }
  return {
    kind: 'document',
    mediaId: item.mediaId,
    name: item.name,
    contentType: item.contentType,
    size: Math.max(item.size, 1),
  }
}

/** Edit and resend: the message's attachments go back into the composer. */
export function attachmentsOf(message: Message): Attachment[] {
  return message.parts.flatMap((part): Attachment[] => {
    if (part.kind === 'image')
      return [
        { kind: 'upload', mediaId: part.mediaId, name: 'image', contentType: 'image/*', size: 0 },
      ]
    if (part.kind === 'document')
      return [
        {
          kind: 'upload',
          mediaId: part.mediaId,
          name: part.name,
          contentType: part.contentType,
          size: part.size,
        },
      ]
    if (part.kind === 'workspace')
      return [{ kind: 'workspace', agentId: part.agentId, path: part.path }]
    return []
  })
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export type PreviewKind = 'image' | 'pdf' | 'markdown' | 'csv' | 'json' | 'text' | 'html' | 'office'
export function previewKind(contentType: string): PreviewKind {
  if (isImage(contentType)) return 'image'
  switch (contentType) {
    case 'application/pdf':
      return 'pdf'
    case 'text/markdown':
      return 'markdown'
    case 'text/csv':
      return 'csv'
    case 'application/json':
      return 'json'
    case 'text/html':
      return 'html'
    case 'text/plain':
      return 'text'
    default:
      return 'office'
  }
}

/** A refusal before uploading, so an obviously oversized file does not travel first; the server still decides. */
export function uploadProblem(file: File): string | null {
  if (file.size === 0) return `${file.name} is empty.`
  if (file.size > MAX_FILE_BYTES) return `${file.name} is larger than 25 MB.`
  if (file.type.startsWith('image/') && file.size > MAX_IMAGE_BYTES)
    return `${file.name} is larger than 8 MB.`
  return null
}
