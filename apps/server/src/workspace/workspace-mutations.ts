import { randomBytes } from 'node:crypto'
import { constants as C } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { withKeyedLock } from '../keyed-lock.ts'
import {
  assertAllowedSegments,
  parseRelativePath,
  validateEntryName,
  WorkspaceError,
} from './policy.ts'
import { WorkspaceAccess, type DirHandle } from './workspace-access.ts'
import { etagOf } from './workspace-content.ts'
import { assertNothingProtected, mapFsError, readBytes, removeTree } from './workspace-fs.ts'
import { MAX_TEXT_BYTES, MAX_UPLOAD_BYTES, type WriteEvent } from './workspace-types.ts'

export class WorkspaceMutations {
  constructor(
    private readonly access: WorkspaceAccess,
    private readonly onWrite: (event: WriteEvent) => void,
  ) {}

  /** Atomically replaces (etag = current etag) or creates (etag = null, refuses an existing file) a text file. */
  async write(
    input: string,
    content: string,
    etag: string | null,
  ): Promise<{ etag: string; size: number }> {
    const bytes = Buffer.from(content, 'utf8')
    if (bytes.length > MAX_TEXT_BYTES)
      throw new WorkspaceError(413, 'payload_too_large', 'The file is too large to edit here.')
    if (bytes.includes(0))
      throw new WorkspaceError(400, 'bad_content', 'Text files can’t contain null characters.')
    return this.commit(this.targetSegments(input), bytes, etag, 'write')
  }

  async upload(input: string, bytes: Buffer): Promise<{ etag: string; size: number }> {
    if (bytes.length > MAX_UPLOAD_BYTES)
      throw new WorkspaceError(413, 'payload_too_large', 'The upload is too large.')
    return this.commit(this.targetSegments(input), bytes, null, 'upload')
  }

  private targetSegments(input: string): string[] {
    const segments = parseRelativePath(input)
    if (segments.length === 0) throw new WorkspaceError(400, 'bad_path', 'A path is required.')
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
    return withKeyedLock(`ws:${path.join(this.access.root, ...segments)}`, async () => {
      const dir = await this.access.strictParent(segments.slice(0, -1))
      const target = `${dir.base}/${name}`
      const temp = `${dir.base}/.score-tmp-${randomBytes(8).toString('hex')}`
      let tempMade = false
      try {
        const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw mapFsError(error)
        })
        if (existing?.isSymbolicLink())
          throw new WorkspaceError(403, 'symlink', 'Score doesn’t change symbolic links.')
        if (existing && !existing.isFile())
          throw new WorkspaceError(400, 'not_a_file', 'That path isn’t a file.')
        if (existing) {
          if (etag === null)
            throw new WorkspaceError(409, 'exists', 'A file with that name already exists.')
          if (existing.size > MAX_TEXT_BYTES)
            throw new WorkspaceError(
              413,
              'payload_too_large',
              'The file is too large to edit here.',
            )
          const current = etagOf(await readBytes(target, MAX_TEXT_BYTES))
          if (current !== etag)
            throw new WorkspaceError(412, 'precondition_failed', 'The file changed on disk.', {
              etag: current,
            })
        } else if (etag !== null) {
          throw new WorkspaceError(412, 'precondition_failed', 'The file was removed from disk.', {
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
        if (existing) {
          // The agent (or anything else) may have written the file while the replacement was being prepared: look
          // again right before replacing. A rename cannot be made atomic against an outside writer; this narrows the
          // window from the whole fsync to the instant between this check and the rename.
          const now = await fs.lstat(target).catch(() => null)
          const unchanged =
            now !== null &&
            now.isFile() &&
            now.ino === existing.ino &&
            now.size === existing.size &&
            now.mtimeMs === existing.mtimeMs &&
            etagOf(await readBytes(target, MAX_TEXT_BYTES)) === etag
          if (!unchanged)
            throw new WorkspaceError(412, 'precondition_failed', 'The file changed on disk.', {
              etag: now?.isFile() ? etagOf(await readBytes(target, MAX_TEXT_BYTES)) : null,
            })
          await fs.rename(temp, target)
        } else {
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
    const dir = await this.access.strictParent(segments.slice(0, -1))
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
      throw new WorkspaceError(400, 'bad_path', 'A folder can’t be moved into itself.')
    const keys = [from, to]
      .map((segments) => `ws:${path.join(this.access.root, ...segments)}`)
      .sort()
    return withKeyedLock(keys[0]!, () =>
      keys[1] === keys[0]
        ? this.moveLocked(from, to)
        : withKeyedLock(keys[1]!, () => this.moveLocked(from, to)),
    )
  }

  private async moveLocked(from: string[], to: string[]): Promise<void> {
    const sourceDir = await this.access.strictParent(from.slice(0, -1))
    let targetDir: DirHandle | undefined
    try {
      targetDir = await this.access.strictParent(to.slice(0, -1))
      const source = `${sourceDir.base}/${from[from.length - 1]!}`
      const target = `${targetDir.base}/${to[to.length - 1]!}`
      const st = await fs.lstat(source).catch((error: unknown) => {
        throw mapFsError(error)
      })
      if (st.isSymbolicLink())
        throw new WorkspaceError(403, 'symlink', 'Score doesn’t change symbolic links.')
      if (!st.isFile() && !st.isDirectory())
        throw new WorkspaceError(400, 'not_a_file', 'That entry can’t be moved.')
      if (
        await fs.lstat(target).then(
          () => true,
          () => false,
        )
      )
        throw new WorkspaceError(409, 'exists', 'Something with that name already exists.')
      if (st.isDirectory()) await fs.rename(source, target)
      else {
        // link never replaces an existing target, unlike rename. Removing the source by pathname could delete a file
        // that replaced it after the link, so the source is first renamed (atomically, whatever is there) to a
        // private name, and only unlinked if it is still the inode that was linked.
        await fs.link(source, target)
        const parked = `${sourceDir.base}/.score-move-${randomBytes(8).toString('hex')}`
        const parkedStat = await fs.rename(source, parked).then(
          () => fs.lstat(parked),
          // Removed by someone else meanwhile: the move has happened.
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null
            throw error
          },
        )
        if (parkedStat === null) {
          // nothing left to remove
        } else if (parkedStat.dev === st.dev && parkedStat.ino === st.ino) await fs.unlink(parked)
        else {
          // A newer file took the source's place: put it back. The name is free for a moment only after the rename
          // above, so the restore uses link (no replace) and, if a third file claimed the name meanwhile, keeps the
          // parked copy rather than losing data. Remaining window: the source name is briefly absent.
          await fs.link(parked, source).then(
            () => fs.unlink(parked),
            () => undefined,
          )
        }
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
    return withKeyedLock(`ws:${path.join(this.access.root, ...segments)}`, async () => {
      const dir = await this.access.strictParent(segments.slice(0, -1))
      try {
        const target = `${dir.base}/${name}`
        const st = await fs.lstat(target).catch((error: unknown) => {
          throw mapFsError(error)
        })
        if (st.isSymbolicLink())
          throw new WorkspaceError(403, 'symlink', 'Score doesn’t change symbolic links.')
        if (st.isDirectory()) {
          if (recursive) {
            // The tree hides protected files (keys, .env) and the browser can't open .git, so a folder holding either
            // is never deleted from here: the owner would be removing things they were never shown.
            await assertNothingProtected(target, { count: 0 }, 0)
            await removeTree(target, { count: 0 }, 0)
          } else await fs.rmdir(target)
        } else if (st.isFile()) await fs.unlink(target)
        else throw new WorkspaceError(400, 'not_a_file', 'That entry can’t be deleted.')
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
