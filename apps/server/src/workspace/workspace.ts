import { createHash, randomBytes } from 'node:crypto'
import { constants as C, type Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { withKeyedLock } from '../keyed-lock.ts'
import {
  assertAllowedSegments,
  checkRoot,
  isInside,
  parseRelativePath,
  validateEntryName,
  WorkspaceError,
  type RootPolicy,
} from './policy.ts'

// File operations inside one workspace root. Rules (design 6.0 § 6.1, lead review 1-2):
// - every request resolves the root and the *parent* of the target with realpath and must stay inside the root;
// - the parent is opened as a directory fd and checked again through /proc/self/fd (Linux), so a swap between the
//   check and the use is caught; the last component is only ever opened with O_NOFOLLOW;
// - mutations require a literal path (no symlink component at all), and never touch a symlink;
// - the blocked list is applied to the requested and to the resolved path.

export const MAX_TEXT_BYTES = 1024 * 1024
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const MAX_RAW_BYTES = 25 * 1024 * 1024
const MAX_DELETE_ENTRIES = 100_000

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

const RAW_TYPES: Record<string, { type: string; magic: (head: Buffer) => boolean }> = {
  '.png': {
    type: 'image/png',
    magic: (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  },
  '.jpg': { type: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  '.jpeg': { type: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  '.gif': { type: 'image/gif', magic: (b) => b.subarray(0, 3).toString('latin1') === 'GIF' },
  '.webp': {
    type: 'image/webp',
    magic: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  '.pdf': { type: 'application/pdf', magic: (b) => b.subarray(0, 4).toString('latin1') === '%PDF' },
}

export function etagOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32)
}

const LINUX = process.platform === 'linux'

interface DirHandle {
  /** Path to use for operations inside the directory: /proc/self/fd/N on Linux, else the resolved path. */
  base: string
  real: string
  sync(): Promise<void>
  close(): Promise<void>
}

export class Workspace {
  private constructor(
    readonly root: string,
    private readonly forbidden: string[],
    private readonly onWrite: (event: WriteEvent) => void,
  ) {}

  /** Opens a workspace; throws 409 `workspace_unavailable` when the root fails the root checks. */
  static async open(
    root: string,
    policy: RootPolicy,
    onWrite: (event: WriteEvent) => void = () => undefined,
  ): Promise<Workspace> {
    const checked = await checkRoot(root, policy)
    if (!checked.ok) throw new WorkspaceError(409, 'workspace_unavailable', checked.reason)
    const forbidden = new Set<string>()
    for (const folder of policy.forbidden) {
      forbidden.add(path.resolve(folder))
      forbidden.add(await fs.realpath(folder).catch(() => path.resolve(folder)))
    }
    return new Workspace(checked.real, [...forbidden], onWrite)
  }

  private assertReachable(real: string): void {
    if (!isInside(this.root, real))
      throw new WorkspaceError(403, 'outside_workspace', 'That path is outside the workspace')
    for (const blocked of this.forbidden)
      if (isInside(blocked, real))
        throw new WorkspaceError(403, 'blocked', 'That path is not available')
  }

  private segmentsOf(real: string): string[] {
    const rel = path.relative(this.root, real)
    return rel === '' ? [] : rel.split(path.sep)
  }

  private async acquireDir(real: string): Promise<DirHandle> {
    let fh
    try {
      fh = await fs.open(real, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW)
    } catch (error) {
      throw mapFsError(error)
    }
    try {
      const base = LINUX ? `/proc/self/fd/${fh.fd}` : real
      if (LINUX) {
        // An intermediate component swapped for a symlink after realpath would be followed by the open above; the
        // fd then names a different directory than the one that was checked.
        const actual = await fs.realpath(base)
        if (actual !== real)
          throw new WorkspaceError(409, 'changed', 'The folder changed while it was being read')
      }
      return {
        base,
        real,
        sync: () => fh.sync().catch(() => undefined),
        close: () => fh.close().catch(() => undefined),
      }
    } catch (error) {
      await fh.close().catch(() => undefined)
      throw error
    }
  }

  /** The real, contained directory a literal parent path names (mutations: no symlink component allowed). */
  private async strictParent(parentSegments: string[]): Promise<DirHandle> {
    const lexical = path.join(this.root, ...parentSegments)
    let real: string
    try {
      real = await fs.realpath(lexical)
    } catch (error) {
      throw mapFsError(error)
    }
    if (real !== lexical)
      throw new WorkspaceError(403, 'symlink', 'Symbolic links are not changed from here')
    this.assertReachable(real)
    return this.acquireDir(real)
  }

  /** Follows symlinks (read-only uses) but only into the workspace; returns the resolved real path. */
  private async resolveForRead(segments: string[], use: 'list' | 'read'): Promise<string> {
    assertAllowedSegments(segments, use)
    let real: string
    try {
      real = await fs.realpath(path.join(this.root, ...segments))
    } catch (error) {
      throw mapFsError(error)
    }
    this.assertReachable(real)
    assertAllowedSegments(this.segmentsOf(real), use)
    return real
  }

  async list(input: string): Promise<TreeEntry[]> {
    const segments = parseRelativePath(input)
    const real = await this.resolveForRead(segments, 'list')
    const dir = await this.acquireDir(real)
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
    if (segments.length === 0) throw new WorkspaceError(400, 'bad_path', 'That path is a folder')
    const real = await this.resolveForRead(segments, 'read')
    const name = path.basename(real)
    const dir = await this.acquireDir(path.dirname(real))
    try {
      const file = `${dir.base}/${name}`
      const lst = await fs.lstat(file).catch((error: unknown) => {
        throw mapFsError(error)
      })
      // The resolved path has no symlink in it; one appearing now is a race.
      if (lst.isSymbolicLink())
        throw new WorkspaceError(409, 'changed', 'The file changed while it was being read')
      if (!lst.isFile()) throw new WorkspaceError(400, 'not_a_file', 'That path is not a file')
      const ext = path.extname(name).toLowerCase()
      const raw = RAW_TYPES[ext]
      const limit = options.download ? MAX_UPLOAD_BYTES : raw ? MAX_RAW_BYTES : MAX_TEXT_BYTES
      if (lst.size > limit) {
        if (options.download)
          throw new WorkspaceError(
            413,
            'payload_too_large',
            'The file is too large to download here',
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

  /** Atomically replaces (etag = current etag) or creates (etag = null, refuses an existing file) a text file. */
  async write(
    input: string,
    content: string,
    etag: string | null,
  ): Promise<{ etag: string; size: number }> {
    const bytes = Buffer.from(content, 'utf8')
    if (bytes.length > MAX_TEXT_BYTES)
      throw new WorkspaceError(413, 'payload_too_large', 'The file is too large to edit here')
    if (bytes.includes(0))
      throw new WorkspaceError(400, 'bad_content', 'Text files cannot contain NUL characters')
    return this.commit(this.targetSegments(input), bytes, etag, 'write')
  }

  async upload(input: string, bytes: Buffer): Promise<{ etag: string; size: number }> {
    if (bytes.length > MAX_UPLOAD_BYTES)
      throw new WorkspaceError(413, 'payload_too_large', 'The upload is too large')
    return this.commit(this.targetSegments(input), bytes, null, 'upload')
  }

  private targetSegments(input: string): string[] {
    const segments = parseRelativePath(input)
    if (segments.length === 0) throw new WorkspaceError(400, 'bad_path', 'A path is required')
    validateEntryName(segments[segments.length - 1]!)
    assertAllowedSegments(segments, 'mutate')
    return segments
  }

  private commit(
    segments: string[],
    bytes: Buffer,
    etag: string | null,
    op: 'write' | 'upload',
  ): Promise<{ etag: string; size: number }> {
    const name = segments[segments.length - 1]!
    return withKeyedLock(`ws:${path.join(this.root, ...segments)}`, async () => {
      const dir = await this.strictParent(segments.slice(0, -1))
      const target = `${dir.base}/${name}`
      const temp = `${dir.base}/.score-tmp-${randomBytes(8).toString('hex')}`
      let tempMade = false
      try {
        const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw mapFsError(error)
        })
        if (existing?.isSymbolicLink())
          throw new WorkspaceError(403, 'symlink', 'Symbolic links are not changed from here')
        if (existing && !existing.isFile())
          throw new WorkspaceError(400, 'not_a_file', 'That path is not a file')
        if (existing) {
          if (etag === null)
            throw new WorkspaceError(409, 'exists', 'A file with that name already exists')
          if (existing.size > MAX_TEXT_BYTES)
            throw new WorkspaceError(413, 'payload_too_large', 'The file is too large to edit here')
          const current = etagOf(await readBytes(target, MAX_TEXT_BYTES))
          if (current !== etag)
            throw new WorkspaceError(412, 'precondition_failed', 'The file changed on disk', {
              etag: current,
            })
        } else if (etag !== null) {
          throw new WorkspaceError(412, 'precondition_failed', 'The file was removed from disk', {
            etag: null,
          })
        }
        // New files take the process umask; a replaced file keeps its permissions.
        const fh = await fs.open(
          temp,
          C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW,
          existing ? 0o600 : 0o666,
        )
        tempMade = true
        try {
          await fh.writeFile(bytes)
          if (existing) await fh.chmod(existing.mode & 0o7777)
          await fh.sync()
        } finally {
          await fh.close()
        }
        if (existing) await fs.rename(temp, target)
        else {
          // link fails if the name appeared meanwhile; rename would silently replace it.
          await fs.link(temp, target)
          await fs.unlink(temp)
        }
        tempMade = false
        await dir.sync()
        this.onWrite({
          op: op === 'upload' ? 'upload' : existing ? 'write' : 'create',
          path: segments.join('/'),
          size: bytes.length,
        })
        return { etag: etagOf(bytes), size: bytes.length }
      } catch (error) {
        throw mapFsError(error)
      } finally {
        if (tempMade) await fs.unlink(temp).catch(() => undefined)
        await dir.close()
      }
    })
  }

  async create(input: string, kind: 'file' | 'dir'): Promise<void> {
    if (kind === 'file') {
      await this.write(input, '', null)
      return
    }
    const segments = this.targetSegments(input)
    const dir = await this.strictParent(segments.slice(0, -1))
    try {
      await fs.mkdir(`${dir.base}/${segments[segments.length - 1]!}`, { mode: 0o777 })
      await dir.sync()
      this.onWrite({ op: 'mkdir', path: segments.join('/') })
    } catch (error) {
      throw mapFsError(error)
    } finally {
      await dir.close()
    }
  }

  async move(fromInput: string, toInput: string): Promise<void> {
    const from = this.targetSegments(fromInput)
    const to = this.targetSegments(toInput)
    if (to.length > from.length && from.every((segment, index) => to[index] === segment))
      throw new WorkspaceError(400, 'bad_path', 'A folder cannot be moved into itself')
    const keys = [from, to].map((segments) => `ws:${path.join(this.root, ...segments)}`).sort()
    return withKeyedLock(keys[0]!, () =>
      keys[1] === keys[0]
        ? this.moveLocked(from, to)
        : withKeyedLock(keys[1]!, () => this.moveLocked(from, to)),
    )
  }

  private async moveLocked(from: string[], to: string[]): Promise<void> {
    const sourceDir = await this.strictParent(from.slice(0, -1))
    let targetDir: DirHandle | undefined
    try {
      targetDir = await this.strictParent(to.slice(0, -1))
      const source = `${sourceDir.base}/${from[from.length - 1]!}`
      const target = `${targetDir.base}/${to[to.length - 1]!}`
      const st = await fs.lstat(source).catch((error: unknown) => {
        throw mapFsError(error)
      })
      if (st.isSymbolicLink())
        throw new WorkspaceError(403, 'symlink', 'Symbolic links are not changed from here')
      if (!st.isFile() && !st.isDirectory())
        throw new WorkspaceError(400, 'not_a_file', 'That entry cannot be moved')
      if (
        await fs.lstat(target).then(
          () => true,
          () => false,
        )
      )
        throw new WorkspaceError(409, 'exists', 'Something with that name already exists')
      if (st.isDirectory()) await fs.rename(source, target)
      else {
        // link + unlink never replaces an existing target, unlike rename.
        await fs.link(source, target)
        await fs.unlink(source)
      }
      await sourceDir.sync()
      await targetDir.sync()
      this.onWrite({ op: 'move', path: from.join('/'), to: to.join('/') })
    } catch (error) {
      throw mapFsError(error)
    } finally {
      await sourceDir.close()
      await targetDir?.close()
    }
  }

  async remove(input: string, recursive: boolean): Promise<void> {
    const segments = this.targetSegments(input)
    const name = segments[segments.length - 1]!
    return withKeyedLock(`ws:${path.join(this.root, ...segments)}`, async () => {
      const dir = await this.strictParent(segments.slice(0, -1))
      try {
        const target = `${dir.base}/${name}`
        const st = await fs.lstat(target).catch((error: unknown) => {
          throw mapFsError(error)
        })
        if (st.isSymbolicLink())
          throw new WorkspaceError(403, 'symlink', 'Symbolic links are not changed from here')
        if (st.isDirectory()) {
          if (recursive) await removeTree(target, { count: 0 }, 0)
          else await fs.rmdir(target)
        } else if (st.isFile()) await fs.unlink(target)
        else throw new WorkspaceError(400, 'not_a_file', 'That entry cannot be deleted')
        await dir.sync()
        this.onWrite({ op: 'delete', path: segments.join('/') })
      } catch (error) {
        throw mapFsError(error)
      } finally {
        await dir.close()
      }
    })
  }
}

// Blocked names are never listed. `.git` itself is listed (its internals are not reachable).
function isBlockedEntry(name: string): boolean {
  try {
    assertAllowedSegments([name], 'list')
    return false
  } catch {
    return true
  }
}

async function readBytes(file: string, limit: number): Promise<Buffer> {
  let fh
  try {
    fh = await fs.open(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK)
  } catch (error) {
    throw mapFsError(error)
  }
  try {
    const st: Stats = await fh.stat()
    if (!st.isFile()) throw new WorkspaceError(400, 'not_a_file', 'That path is not a file')
    if (st.size > limit) throw new WorkspaceError(413, 'payload_too_large', 'The file is too large')
    const buffer = Buffer.alloc(st.size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await fh.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return buffer.subarray(0, offset)
  } finally {
    await fh.close()
  }
}

function decodeText(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8192).includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** Depth-first delete that opens every directory with O_NOFOLLOW (via fd paths) and unlinks symlinks as links. */
async function removeTree(
  dirPath: string,
  budget: { count: number },
  depth: number,
): Promise<void> {
  if (depth > 64) throw new WorkspaceError(400, 'too_deep', 'The folder is nested too deeply')
  const fh = await fs.open(dirPath, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW)
  try {
    const base = LINUX ? `/proc/self/fd/${fh.fd}` : dirPath
    for (const child of await fs.readdir(base)) {
      if (++budget.count > MAX_DELETE_ENTRIES)
        throw new WorkspaceError(400, 'too_large', 'The folder has too many entries')
      const childPath = `${base}/${child}`
      const st = await fs.lstat(childPath)
      if (st.isDirectory()) await removeTree(childPath, budget, depth + 1)
      else await fs.unlink(childPath)
    }
  } finally {
    await fh.close()
  }
  await fs.rmdir(dirPath)
}

function mapFsError(error: unknown): unknown {
  if (error instanceof WorkspaceError) return error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return new WorkspaceError(404, 'not_found', 'Not found')
    case 'ELOOP':
      return new WorkspaceError(403, 'symlink', 'Symbolic links are not followed here')
    case 'EEXIST':
      return new WorkspaceError(409, 'exists', 'Something with that name already exists')
    case 'ENOTEMPTY':
      return new WorkspaceError(409, 'not_empty', 'The folder is not empty')
    case 'EACCES':
    case 'EPERM':
      return new WorkspaceError(403, 'forbidden', 'The operating system denied access')
    case 'ENOSPC':
      return new WorkspaceError(507, 'no_space', 'The disk is full')
    case 'EXDEV':
      return new WorkspaceError(409, 'conflict', 'That move crosses file systems')
    default:
      return error
  }
}
