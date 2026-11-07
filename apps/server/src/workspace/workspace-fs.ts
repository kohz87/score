import { constants as C, type Stats } from 'node:fs'
import fs from 'node:fs/promises'
import { isProtectedName, WorkspaceError } from './policy.ts'
import { MAX_DELETE_ENTRIES } from './workspace-types.ts'

export const LINUX = process.platform === 'linux'

export async function readBytes(file: string, limit: number): Promise<Buffer> {
  let fh
  try {
    fh = await fs.open(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK)
  } catch (error) {
    throw mapFsError(error)
  }
  try {
    const st: Stats = await fh.stat()
    if (!st.isFile()) throw new WorkspaceError(400, 'not_a_file', 'That path isn’t a file.')
    if (st.size > limit)
      throw new WorkspaceError(413, 'payload_too_large', 'The file is too large.')
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

/** Depth-first delete that opens every directory with O_NOFOLLOW (via fd paths) and unlinks symlinks as links. */
export async function assertNothingProtected(
  dirPath: string,
  budget: { count: number },
  depth: number,
): Promise<void> {
  if (depth > 64) throw new WorkspaceError(400, 'too_deep', 'The folder is nested too deeply.')
  const fh = await fs.open(dirPath, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW)
  try {
    const base = LINUX ? `/proc/self/fd/${fh.fd}` : dirPath
    for (const child of await fs.readdir(base)) {
      if (++budget.count > MAX_DELETE_ENTRIES)
        throw new WorkspaceError(400, 'too_large', 'The folder has too many entries.')
      if (isProtectedName(child))
        throw new WorkspaceError(
          409,
          'protected_inside',
          'The folder holds protected files (keys, .env or a git repository); delete it on the machine itself.',
        )
      const st = await fs.lstat(`${base}/${child}`)
      if (st.isDirectory()) await assertNothingProtected(`${base}/${child}`, budget, depth + 1)
    }
  } finally {
    await fh.close()
  }
}

export async function removeTree(
  dirPath: string,
  budget: { count: number },
  depth: number,
): Promise<void> {
  if (depth > 64) throw new WorkspaceError(400, 'too_deep', 'The folder is nested too deeply.')
  const fh = await fs.open(dirPath, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW)
  try {
    const base = LINUX ? `/proc/self/fd/${fh.fd}` : dirPath
    for (const child of await fs.readdir(base)) {
      if (++budget.count > MAX_DELETE_ENTRIES)
        throw new WorkspaceError(400, 'too_large', 'The folder has too many entries.')
      // Checked again here: something protected may have appeared since the scan.
      if (isProtectedName(child))
        throw new WorkspaceError(409, 'protected_inside', 'The folder holds protected files.')
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

export function mapFsError(error: unknown): unknown {
  if (error instanceof WorkspaceError) return error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return new WorkspaceError(404, 'not_found', 'Not found.')
    case 'ELOOP':
      return new WorkspaceError(403, 'symlink', 'Score doesn’t follow symbolic links.')
    case 'EEXIST':
      return new WorkspaceError(409, 'exists', 'Something with that name already exists.')
    case 'ENOTEMPTY':
      return new WorkspaceError(409, 'not_empty', 'The folder isn’t empty.')
    case 'EACCES':
    case 'EPERM':
      return new WorkspaceError(403, 'forbidden', 'The operating system denied access.')
    case 'ENOSPC':
      return new WorkspaceError(507, 'no_space', 'The disk is full.')
    case 'EXDEV':
      return new WorkspaceError(409, 'conflict', 'That move crosses file systems.')
    default:
      return error
  }
}
