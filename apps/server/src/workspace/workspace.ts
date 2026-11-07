import fs from 'node:fs/promises'
import path from 'node:path'
import { checkRoot, WorkspaceError, type RootPolicy } from './policy.ts'
import { WorkspaceAccess } from './workspace-access.ts'
import { WorkspaceMutations } from './workspace-mutations.ts'
import { WorkspaceReader } from './workspace-reader.ts'
import {
  MAX_TEXT_BYTES,
  MAX_UPLOAD_BYTES,
  type ReadResult,
  type TreeEntry,
  type WriteEvent,
} from './workspace-types.ts'

export { etagOf } from './workspace-content.ts'
export { MAX_TEXT_BYTES, MAX_UPLOAD_BYTES }
export type { WriteEvent }

// File operations inside one workspace root. Rules (design 6.0 § 6.1, lead review 1-2):
// - every request resolves the root and the *parent* of the target with realpath and must stay inside the root;
// - the parent is opened as a directory fd and checked again through /proc/self/fd (Linux), so a swap between the
//   check and the use is caught; the last component is only ever opened with O_NOFOLLOW;
// - mutations require a literal path (no symlink component at all), and never touch a symlink;
// - the blocked list is applied to the requested and to the resolved path.

export class Workspace {
  private readonly reads: WorkspaceReader
  private readonly mutations: WorkspaceMutations

  private constructor(
    readonly root: string,
    forbidden: string[],
    onWrite: (event: WriteEvent) => void,
  ) {
    const access = new WorkspaceAccess(root, forbidden)
    this.reads = new WorkspaceReader(access)
    this.mutations = new WorkspaceMutations(access, onWrite)
  }

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

  async list(input: string): Promise<TreeEntry[]> {
    return this.reads.list(input)
  }

  async read(input: string, options: { download?: boolean } = {}): Promise<ReadResult> {
    return this.reads.read(input, options)
  }

  async write(
    input: string,
    content: string,
    etag: string | null,
  ): Promise<{ etag: string; size: number }> {
    return this.mutations.write(input, content, etag)
  }

  async upload(input: string, bytes: Buffer): Promise<{ etag: string; size: number }> {
    return this.mutations.upload(input, bytes)
  }

  async create(input: string, kind: 'file' | 'dir'): Promise<void> {
    return this.mutations.create(input, kind)
  }

  async move(fromInput: string, toInput: string): Promise<void> {
    return this.mutations.move(fromInput, toInput)
  }

  async remove(input: string, recursive: boolean): Promise<void> {
    return this.mutations.remove(input, recursive)
  }
}
