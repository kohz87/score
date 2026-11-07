import { constants as C } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { assertAllowedSegments, isInside, WorkspaceError } from './policy.ts'
import { LINUX, mapFsError } from './workspace-fs.ts'

export interface DirHandle {
  /** Path to use for operations inside the directory: /proc/self/fd/N on Linux, else the resolved path. */
  base: string
  real: string
  sync(): Promise<void>
  close(): Promise<void>
}

export class WorkspaceAccess {
  constructor(
    readonly root: string,
    private readonly forbidden: string[],
  ) {}

  private assertReachable(real: string): void {
    if (!isInside(this.root, real))
      throw new WorkspaceError(403, 'outside_workspace', 'That path is outside the workspace.')
    for (const blocked of this.forbidden)
      if (isInside(blocked, real))
        throw new WorkspaceError(403, 'blocked', 'That path isn’t available.')
  }

  private segmentsOf(real: string): string[] {
    const rel = path.relative(this.root, real)
    return rel === '' ? [] : rel.split(path.sep)
  }

  async acquireDir(real: string): Promise<DirHandle> {
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
          throw new WorkspaceError(409, 'changed', 'The folder changed while it was being read.')
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
  async strictParent(parentSegments: string[]): Promise<DirHandle> {
    const lexical = path.join(this.root, ...parentSegments)
    let real: string
    try {
      real = await fs.realpath(lexical)
    } catch (error) {
      throw mapFsError(error)
    }
    if (real !== lexical)
      throw new WorkspaceError(403, 'symlink', 'Score doesn’t change symbolic links.')
    this.assertReachable(real)
    return this.acquireDir(real)
  }

  /** Follows symlinks (read-only uses) but only into the workspace; returns the resolved real path. */
  async resolveForRead(segments: string[], use: 'list' | 'read'): Promise<string> {
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
}
