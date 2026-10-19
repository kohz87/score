import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  type Stats,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { AvatarRevSchema, ProfileNameSchema } from '@score/contract'
import type { AvatarExt } from './sniff.ts'

const EXTS: readonly AvatarExt[] = ['png', 'jpg', 'webp']

/**
 * Imported agent pictures on disk (PLAN 10.2): `$SCORE_HOME/avatars/<agentId>/<rev>.<png|jpg|webp>`, folders 0700 and
 * files 0600. A picture is written to a temp name and renamed, so a reader never sees half a file. Nothing here ever
 * follows a symbolic link: the avatars folder, the agent's folder and the file are each checked with `lstat`, and the
 * file is opened with O_NOFOLLOW. Score's home itself is the owner's own and may be a link.
 */
export class AvatarStore {
  readonly root: string

  constructor(home: string) {
    this.root = join(home, 'avatars')
  }

  private folder(agentId: string): string {
    // The id becomes a folder name: only a plain profile name does.
    return join(this.root, ProfileNameSchema.parse(agentId))
  }

  private ensureFolder(path: string): void {
    let info: Stats
    try {
      info = lstatSync(path)
    } catch {
      mkdirSync(path, { mode: 0o700 })
      info = lstatSync(path)
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error('The pictures folder is not a plain folder.')
    chmodSync(path, 0o700)
  }

  /** Writes the picture under a new random revision and returns it. The caller records it, then removes the old one. */
  write(agentId: string, ext: AvatarExt, bytes: Buffer): string {
    const folder = this.folder(agentId)
    mkdirSync(join(this.root, '..'), { recursive: true })
    this.ensureFolder(this.root)
    this.ensureFolder(folder)
    const rev = randomBytes(12).toString('base64url')
    const file = join(folder, `${rev}.${ext}`)
    const temp = `${file}.tmp-${randomBytes(4).toString('hex')}`
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try {
      let written = 0
      while (written < bytes.length) written += writeSync(fd, bytes, written)
      fsyncSync(fd)
    } catch (error) {
      closeSync(fd)
      rmSync(temp, { force: true })
      throw error
    }
    closeSync(fd)
    try {
      renameSync(temp, file)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
    return rev
  }

  private isPlainFolder(path: string): boolean {
    try {
      const info = lstatSync(path)
      return info.isDirectory() && !info.isSymbolicLink()
    } catch {
      return false
    }
  }

  /** The picture of this revision, or null: unknown, not a regular file, or a link anywhere on the way. */
  read(agentId: string, rev: string): { bytes: Buffer; ext: AvatarExt } | null {
    if (!ProfileNameSchema.safeParse(agentId).success || !AvatarRevSchema.safeParse(rev).success)
      return null
    const folder = this.folder(agentId)
    if (!this.isPlainFolder(this.root) || !this.isPlainFolder(folder)) return null
    for (const ext of EXTS) {
      const file = join(folder, `${rev}.${ext}`)
      let fd: number | undefined
      try {
        if (!lstatSync(file).isFile()) continue
        // O_NOFOLLOW closes the gap between the check and the open for the file itself.
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
        return fstatSync(fd).isFile() ? { bytes: readFileSync(fd), ext } : null
      } catch {
        continue
      } finally {
        if (fd !== undefined) closeSync(fd)
      }
    }
    return null
  }

  /** Removes one revision, whatever its type. Absent is fine; nothing else in the folder is touched. */
  remove(agentId: string, rev: string): void {
    if (!ProfileNameSchema.safeParse(agentId).success || !AvatarRevSchema.safeParse(rev).success)
      return
    const folder = this.folder(agentId)
    if (!this.isPlainFolder(this.root) || !this.isPlainFolder(folder)) return
    for (const ext of EXTS) rmSync(join(folder, `${rev}.${ext}`), { force: true })
  }

  /** Removes the agent's whole folder (a link planted in its place is removed as a link, never followed). */
  removeAgent(agentId: string): void {
    if (!ProfileNameSchema.safeParse(agentId).success || !this.isPlainFolder(this.root)) return
    const folder = this.folder(agentId)
    try {
      if (lstatSync(folder).isSymbolicLink()) unlinkSync(folder)
      else rmSync(folder, { recursive: true, force: true })
    } catch {
      // Already gone.
    }
  }

  /**
   * At start: keeps exactly the picture each agent's row names and removes every stray, such as a temp file from a
   * crash mid-write, a revision replaced just before a crash, or a picture whose row was never committed.
   * `current` maps agent id to its current revision.
   */
  recover(current: ReadonlyMap<string, string>): void {
    if (!this.isPlainFolder(this.root)) return
    for (const name of readdirSync(this.root)) {
      const folder = join(this.root, name)
      const rev = current.get(name)
      if (rev === undefined || !this.isPlainFolder(folder)) {
        rmSync(folder, { recursive: true, force: true })
        continue
      }
      const keep = new Set(EXTS.map((ext) => `${rev}.${ext}`))
      for (const entry of readdirSync(folder)) {
        const path = join(folder, entry)
        if (!keep.has(entry) || !lstatSync(path).isFile())
          rmSync(path, { recursive: true, force: true })
      }
    }
  }
}
