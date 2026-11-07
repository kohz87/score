export const MAX_TEXT_BYTES = 1024 * 1024
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
export const MAX_RAW_BYTES = 25 * 1024 * 1024
export const MAX_DELETE_ENTRIES = 100_000

export interface TreeEntry {
  name: string
  kind: 'file' | 'dir' | 'symlink'
  size: number
  mtime: string
  hidden: boolean
}

export type ReadResult =
  | { kind: 'text'; content: string; etag: string; size: number; mtime: string }
  | { kind: 'raw'; contentType: string; bytes: Buffer; etag: string }
  | { kind: 'binary'; size: number; reason: 'binary' | 'too_large' }
  | { kind: 'download'; bytes: Buffer; name: string }

export interface WriteEvent {
  op: 'write' | 'create' | 'mkdir' | 'move' | 'delete' | 'upload'
  path: string
  to?: string
  size?: number
}
