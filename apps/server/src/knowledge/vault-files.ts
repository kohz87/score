import { createHash, randomUUID } from 'node:crypto'
import { constants as C, createReadStream, type ReadStream, type Stats } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { MAX_NOTE_BYTES, etagOf, hashContent } from './note.ts'
import { MAX_READ_BYTES, MAX_STORE_BYTES } from './doc-types.ts'
import { moveNoReplace, syncDir } from './move-file.ts'
import { HttpError } from '../errors.ts'
import { READ_CHUNK_BYTES } from './vault-types.ts'
import type { VaultRuntime } from './vault-runtime.ts'

export const fileMethods = {
  // ---- paths and files ---------------------------------------------------------------------------------------

  /**
   * Walks the segments from the vault root without following symlinks. Missing parents give `exists: false`;
   * a symlink or a file in the way is refused. Returns the absolute path of the last segment.
   */
  async lookup(
    this: VaultRuntime,
    segments: string[],
  ): Promise<{ abs: string; stat: Stats | null }> {
    let current = this.root
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment)
      let stat
      try {
        stat = await fs.lstat(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { abs: path.join(this.root, ...segments), stat: null }
        }
        throw error
      }
      if (stat.isSymbolicLink())
        throw new HttpError(400, 'bad_path', 'Score doesn’t follow links inside Knowledge.')
      const last = index === segments.length - 1
      if (!last && !stat.isDirectory())
        throw new HttpError(400, 'bad_path', 'A file is in the way of that folder.')
      if (last) return { abs: current, stat }
    }
    return { abs: current, stat: null }
  },

  /** Creates missing parent folders, then checks the real parent is still inside the vault (symlink race). */
  async prepareParent(this: VaultRuntime, rel: string): Promise<string> {
    const abs = path.join(this.root, ...rel.split('/'))
    const parent = path.dirname(abs)
    await fs.mkdir(parent, { recursive: true })
    await this.assertParent(parent)
    return abs
  },

  async assertParent(this: VaultRuntime, parent: string): Promise<void> {
    const real = await fs.realpath(parent)
    if (real !== parent)
      throw new HttpError(400, 'bad_path', 'That folder points outside Knowledge.')
  },

  /** The hashes the file at `abs` may be known by (bytes; for a small file also its UTF-8 round trip); `[null]` when there is none. */
  async currentHashes(this: VaultRuntime, abs: string): Promise<Array<string | null>> {
    try {
      const size = (await fs.lstat(abs)).size
      if (size > MAX_READ_BYTES) return [await this.hashContained(abs, MAX_STORE_BYTES)]
      const bytes = await this.readContainedBuffer(abs, MAX_READ_BYTES)
      return [hashContent(bytes), hashContent(bytes.toString('utf8'))]
    } catch {
      return [null]
    }
  },

  /**
   * `expect`: the content hash the target must still have (null = must not exist) right before it is replaced.
   * A new target is published with `link`, which never replaces; an existing one is replaced only while it still
   * has the expected hash. Without `expect` the target is replaced unconditionally (restores, seeds).
   * `durable`: the new content and the folder entry are flushed to disk before returning.
   */
  async atomicWrite(
    this: VaultRuntime,
    abs: string,
    content: string | Uint8Array,
    expect?: { hash: string | null },
    durable = false,
  ): Promise<void> {
    const parent = path.dirname(abs)
    const temp = path.join(parent, `.score-${randomUUID()}.tmp`)
    try {
      const handle = await fs.open(temp, 'wx', 0o644)
      try {
        await handle.writeFile(content)
        if (durable) await handle.sync()
      } finally {
        await handle.close()
      }
      await this.assertParent(parent)
      if (expect) {
        const now = await this.currentHashes(abs)
        if (!now.includes(expect.hash)) {
          const first = now[0] ?? null
          throw new HttpError(412, 'precondition_failed', 'The note changed after you opened it.', {
            etag: first === null ? null : etagOf(first),
          })
        }
      }
      if (expect?.hash === null) {
        await this.moveNoReplace(temp, abs)
      } else {
        await fs.rename(temp, abs)
        if (durable) await syncDir(parent)
      }
      await this.assertParent(parent)
    } catch (error) {
      await fs.rm(temp, { force: true })
      throw error
    }
  },

  /** Moves `source` to `dest`, failing with 409 instead of replacing anything there (see move-file.ts). */
  async moveNoReplace(
    this: VaultRuntime,
    source: string,
    dest: string,
  ): Promise<{ synced: boolean }> {
    return moveNoReplace(source, dest)
  },

  /**
   * Reads a file that must live at exactly `abs` inside the vault: opened without following a symlink in the last
   * component, and on Linux the open descriptor's real path must still be `abs`, so a folder swapped for a symlink
   * after the path was checked cannot make Score read (and index) a file elsewhere.
   */
  async readContained(this: VaultRuntime, abs: string): Promise<string> {
    return (await this.readContainedBuffer(abs)).toString('utf8')
  },

  /** Opens a plain file inside the vault: no symlink at the end, and the descriptor must still be at `abs` (Linux). */
  async openContained(this: VaultRuntime, abs: string): Promise<FileHandle> {
    const handle = await fs.open(abs, C.O_RDONLY | C.O_NOFOLLOW)
    try {
      if (process.platform === 'linux') {
        const actual = await fs.realpath(`/proc/self/fd/${handle.fd}`)
        if (actual !== abs)
          throw new HttpError(400, 'bad_path', 'The note moved while it was being read.')
      }
      return handle
    } catch (error) {
      await handle.close()
      throw error
    }
  },

  /** `maxBytes` is checked on the open descriptor and while reading, so a file that grows after the size check cannot be slurped whole. */
  async readContainedBuffer(
    this: VaultRuntime,
    abs: string,
    maxBytes = MAX_NOTE_BYTES,
  ): Promise<Buffer> {
    const handle = await this.openContained(abs)
    try {
      const tooLarge = () =>
        new HttpError(413, 'payload_too_large', 'That file is too large to open.')
      if ((await handle.stat()).size > maxBytes) throw tooLarge()
      const chunks: Buffer[] = []
      let total = 0
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total))
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        if (bytesRead === 0) break
        total += bytesRead
        if (total > maxBytes) throw tooLarge()
        chunks.push(chunk.subarray(0, bytesRead))
      }
      return Buffer.concat(chunks, total)
    } finally {
      await handle.close()
    }
  },

  /** The SHA-256 of a file, read in chunks (never whole), with the same containment and size checks as the buffer reader. */
  async hashContained(this: VaultRuntime, abs: string, maxBytes: number): Promise<string> {
    const handle = await this.openContained(abs)
    try {
      if ((await handle.stat()).size > maxBytes)
        throw new HttpError(413, 'payload_too_large', 'That file is too large to open.')
      const hash = createHash('sha256')
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES)
      let total = 0
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        if (bytesRead === 0) break
        total += bytesRead
        // A file that grows while it is read is refused, like in the buffer reader.
        if (total > maxBytes)
          throw new HttpError(413, 'payload_too_large', 'That file is too large to open.')
        hash.update(chunk.subarray(0, bytesRead))
      }
      return hash.digest('hex')
    } finally {
      await handle.close()
    }
  },

  /** `length` bytes from `position` (fewer at the end of the file), one bounded positional read. */
  async readContainedRange(
    this: VaultRuntime,
    abs: string,
    position: number,
    length: number,
  ): Promise<Buffer> {
    const handle = await this.openContained(abs)
    try {
      const out = Buffer.alloc(length)
      const { bytesRead } = await handle.read(out, 0, length, position)
      return out.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  },

  /**
   * A file to stream out: its size, its first bytes (for sniffing) and a stream from the same descriptor. The stream
   * closes the descriptor when it ends or is destroyed.
   */
  async openContainedStream(
    this: VaultRuntime,
    abs: string,
    maxBytes: number,
    headBytes = 64,
  ): Promise<{ size: number; head: Buffer; stream: ReadStream }> {
    const handle = await this.openContained(abs)
    try {
      const stat = await handle.stat()
      if (stat.size > maxBytes)
        throw new HttpError(413, 'payload_too_large', 'That file is too large.')
      const head = Buffer.alloc(Math.min(headBytes, stat.size))
      await handle.read(head, 0, head.length, 0)
      // `end` pins the length announced to the client even if the file grows meanwhile.
      const stream = createReadStream('', {
        fd: handle,
        start: 0,
        end: Math.max(stat.size - 1, 0),
        autoClose: true,
      })
      return { size: stat.size, head, stream }
    } catch (error) {
      await handle.close()
      throw error
    }
  },

  async readRaw(this: VaultRuntime, abs: string, stat: Stats): Promise<string> {
    if (!stat.isFile()) throw new HttpError(400, 'not_a_note', 'That isn’t a note.')
    if (stat.size > MAX_NOTE_BYTES)
      throw new HttpError(413, 'payload_too_large', 'That note is too large to open.')
    return this.readContained(abs)
  },
}

export type FileMethods = typeof fileMethods
