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
  writeSync,
  type Stats,
} from 'node:fs'
import { join } from 'node:path'
import {
  PackRevSchema,
  PetActivitySchema,
  ProfileNameSchema,
  type PetActivity,
} from '@score/contract'
import { PACK_EXTENSIONS, type PackExt } from './sniff.ts'

/**
 * Uploaded pet packs on disk (PLAN 10.2): `$SCORE_HOME/packs/<agentId>/<rev>/<activity>.<webp|png|gif>`, folders 0700
 * and files 0600. A pack is written into a temp folder and renamed into place, so a reader never sees half a pack.
 * Nothing here ever follows a symbolic link: the packs folder, the agent's folder, the revision's folder and the file
 * are each checked with `lstat`, and the file is opened with O_NOFOLLOW. Score's home itself is the owner's own and may
 * be a link.
 */
export class PackStore {
  readonly root: string

  constructor(home: string) {
    this.root = join(home, 'packs')
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
      throw new Error('The packs folder is not a plain folder.')
    chmodSync(path, 0o700)
  }

  private isPlainFolder(path: string): boolean {
    try {
      const info = lstatSync(path)
      return info.isDirectory() && !info.isSymbolicLink()
    } catch {
      return false
    }
  }

  /** Writes the files as a new random revision and returns it. The caller records it, then removes the old one. */
  write(agentId: string, files: { activity: PetActivity; ext: PackExt; bytes: Buffer }[]): string {
    const folder = this.folder(agentId)
    const names = files.map((file) => `${PetActivitySchema.parse(file.activity)}.${file.ext}`)
    mkdirSync(join(this.root, '..'), { recursive: true })
    this.ensureFolder(this.root)
    this.ensureFolder(folder)
    const rev = randomBytes(12).toString('base64url')
    const temp = join(folder, `.tmp-${randomBytes(4).toString('hex')}`)
    mkdirSync(temp, { mode: 0o700 })
    try {
      for (const [index, file] of files.entries()) {
        // 'wx': a second file for the same name is a bug in the caller, not something to overwrite.
        const fd = openSync(
          join(temp, names[index]!),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        )
        try {
          let written = 0
          while (written < file.bytes.length) written += writeSync(fd, file.bytes, written)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
      }
      renameSync(temp, join(folder, rev))
    } catch (error) {
      rmSync(temp, { recursive: true, force: true })
      throw error
    }
    return rev
  }

  /** One file of a revision, or null: unknown, not a regular file, or a link anywhere on the way. */
  read(agentId: string, rev: string, activity: string): { bytes: Buffer; ext: PackExt } | null {
    if (
      !ProfileNameSchema.safeParse(agentId).success ||
      !PackRevSchema.safeParse(rev).success ||
      !PetActivitySchema.safeParse(activity).success
    )
      return null
    const folder = join(this.folder(agentId), rev)
    if (
      !this.isPlainFolder(this.root) ||
      !this.isPlainFolder(this.folder(agentId)) ||
      !this.isPlainFolder(folder)
    )
      return null
    for (const ext of PACK_EXTENSIONS) {
      const file = join(folder, `${activity}.${ext}`)
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

  /** Removes one revision. Absent is fine; nothing else in the agent's folder is touched. */
  remove(agentId: string, rev: string): void {
    if (!ProfileNameSchema.safeParse(agentId).success || !PackRevSchema.safeParse(rev).success)
      return
    const folder = this.folder(agentId)
    if (!this.isPlainFolder(this.root) || !this.isPlainFolder(folder)) return
    rmSync(join(folder, rev), { recursive: true, force: true })
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
   * At start: keeps exactly the revision each agent's row names and removes every stray, such as a temp folder from a
   * crash mid-write, a revision replaced just before a crash, or a pack whose row was never committed.
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
      for (const entry of readdirSync(folder))
        if (entry !== rev || !this.isPlainFolder(join(folder, entry)))
          rmSync(join(folder, entry), { recursive: true, force: true })
    }
  }
}
