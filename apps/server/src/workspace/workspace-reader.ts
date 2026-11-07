import fs from 'node:fs/promises'
import path from 'node:path'
import { parseRelativePath, WorkspaceError } from './policy.ts'
import { WorkspaceAccess } from './workspace-access.ts'
import { decodeText, etagOf, isBlockedEntry, RAW_TYPES } from './workspace-content.ts'
import { mapFsError, readBytes } from './workspace-fs.ts'
import {
  MAX_RAW_BYTES,
  MAX_TEXT_BYTES,
  MAX_UPLOAD_BYTES,
  type ReadResult,
  type TreeEntry,
} from './workspace-types.ts'

export class WorkspaceReader {
  constructor(private readonly access: WorkspaceAccess) {}

  async list(input: string): Promise<TreeEntry[]> {
    const segments = parseRelativePath(input)
    const real = await this.access.resolveForRead(segments, 'list')
    const dir = await this.access.acquireDir(real)
    try {
      const names = await fs.readdir(dir.base)
      const entries: TreeEntry[] = []
      for (const name of names) {
        if (isBlockedEntry(name)) continue
        const st = await fs.lstat(`${dir.base}/${name}`).catch(() => null)
        if (!st) continue
        const kind = st.isSymbolicLink()
          ? 'symlink'
          : st.isDirectory()
            ? 'dir'
            : st.isFile()
              ? 'file'
              : null
        if (!kind) continue
        entries.push({
          name,
          kind,
          size: kind === 'dir' ? 0 : st.size,
          mtime: st.mtime.toISOString(),
          hidden: name.startsWith('.'),
        })
      }
      entries.sort(
        (a, b) =>
          Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name),
      )
      return entries
    } finally {
      await dir.close()
    }
  }

  async read(input: string, options: { download?: boolean } = {}): Promise<ReadResult> {
    const segments = parseRelativePath(input)
    if (segments.length === 0) throw new WorkspaceError(400, 'bad_path', 'That path is a folder.')
    const real = await this.access.resolveForRead(segments, 'read')
    const name = path.basename(real)
    const dir = await this.access.acquireDir(path.dirname(real))
    try {
      const file = `${dir.base}/${name}`
      const lst = await fs.lstat(file).catch((error: unknown) => {
        throw mapFsError(error)
      })
      // The resolved path has no symlink in it; one appearing now is a race.
      if (lst.isSymbolicLink())
        throw new WorkspaceError(409, 'changed', 'The file changed while it was being read.')
      if (!lst.isFile()) throw new WorkspaceError(400, 'not_a_file', 'That path isn’t a file.')
      const ext = path.extname(name).toLowerCase()
      const raw = RAW_TYPES[ext]
      const limit = options.download ? MAX_UPLOAD_BYTES : raw ? MAX_RAW_BYTES : MAX_TEXT_BYTES
      if (lst.size > limit) {
        if (options.download)
          throw new WorkspaceError(
            413,
            'payload_too_large',
            'The file is too large to download here.',
          )
        return { kind: 'binary', size: lst.size, reason: 'too_large' }
      }
      const bytes = await readBytes(file, limit)
      if (options.download) return { kind: 'download', bytes, name }
      if (raw && raw.magic(bytes))
        return { kind: 'raw', contentType: raw.type, bytes, etag: etagOf(bytes) }
      const text = decodeText(bytes)
      if (text === null) return { kind: 'binary', size: bytes.length, reason: 'binary' }
      return {
        kind: 'text',
        content: text,
        etag: etagOf(bytes),
        size: bytes.length,
        mtime: lst.mtime.toISOString(),
      }
    } finally {
      await dir.close()
    }
  }
}
