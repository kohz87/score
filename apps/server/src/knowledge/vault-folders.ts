import fs from 'node:fs/promises'
import path from 'node:path'
import type { KnowledgeAuthor } from '@score/contract'
import { HttpError } from '../errors.ts'
import { isDocumentPath } from './doc-types.ts'
import { parseVaultPath } from './note.ts'
import type { MoveSkipped } from './vault-types.ts'
import type { VaultRuntime } from './vault-runtime.ts'

export const folderMethods = {
  /** A new, empty folder (git does not track empty folders; the tree lists it from the disk). */
  async createFolder(this: VaultRuntime, input: string): Promise<{ path: string }> {
    const segments = parseVaultPath(input)
    if (segments.some((segment) => segment.startsWith('.')))
      throw new HttpError(400, 'bad_path', 'Hidden files and folders are not part of Knowledge.')
    return this.serial(async () => {
      const { stat } = await this.lookup(segments)
      if (stat) throw new HttpError(409, 'exists', 'That name already exists.')
      await this.prepareParent(segments.join('/'))
      await fs.mkdir(path.join(this.root, ...segments))
      await this.publish({ path: segments.join('/'), kind: 'written', to: null, by: 'you' })
      return { path: segments.join('/') }
    })
  },

  /** Every file and folder under `folder` (paths relative to the vault), deepest folders first; hidden ones skipped. */
  async folderContents(
    this: VaultRuntime,
    folder: string,
  ): Promise<{ files: string[]; folders: string[]; unmanaged: string[] }> {
    const files: string[] = []
    const folders: string[] = []
    // Hidden entries and links are never followed or touched; they are reported, since they keep the folder (review).
    const unmanaged: string[] = []
    const walk = async (rel: string): Promise<void> => {
      for (const entry of await fs.readdir(path.join(this.root, ...rel.split('/')), {
        withFileTypes: true,
      })) {
        const child = `${rel}/${entry.name}`
        if (entry.name.startsWith('.')) unmanaged.push(child)
        else if (entry.isDirectory()) {
          await walk(child)
          folders.push(child)
        } else if (entry.isFile()) files.push(child)
        else unmanaged.push(child)
      }
    }
    await walk(folder)
    return { files, folders, unmanaged }
  },

  /** Removes the now-empty folders under `folder` (and `folder` itself), deepest first; a folder still in use stays. */
  async pruneFolders(this: VaultRuntime, folder: string, folders: string[]): Promise<void> {
    for (const rel of [...folders, folder]) {
      try {
        await fs.rmdir(path.join(this.root, ...rel.split('/')))
      } catch {
        // Not empty (something Score doesn't manage, or a file added meanwhile): it stays.
      }
    }
  },

  /**
   * 3.14.5 (owner): renames or moves a folder. Each note moves as `moveNote` moves one (crash-safe, its links rewritten),
   * each document as `docs.move`, and empty subfolders come along; a file Score doesn't manage stays where it is and is
   * reported. Not one transaction: each item is moved safely on its own, and a failure is reported, not hidden.
   */
  async moveFolder(
    this: VaultRuntime,
    fromInput: string,
    toInput: string,
    updateLinks: boolean,
    author: KnowledgeAuthor = 'you',
  ): Promise<{
    path: string
    moved: number
    updatedNotes: number
    skipped: MoveSkipped[]
    leftBehind: Array<{ path: string; reason: string }>
  }> {
    const fromSegments = parseVaultPath(fromInput)
    const toSegments = parseVaultPath(toInput)
    if ([...fromSegments, ...toSegments].some((segment) => segment.startsWith('.')))
      throw new HttpError(400, 'bad_path', 'Hidden files and folders are not part of Knowledge.')
    const from = fromSegments.join('/')
    const to = toSegments.join('/')
    if (to === from) throw new HttpError(409, 'exists', 'That name already exists.')
    if (to.startsWith(`${from}/`))
      throw new HttpError(400, 'bad_path', 'A folder can’t move into itself.')
    const { files, folders, unmanaged } = await this.serial(async () => {
      const source = await this.lookup(fromSegments)
      if (!source.stat?.isDirectory())
        throw new HttpError(404, 'not_found', 'Couldn’t find that folder.')
      if ((await this.lookup(toSegments)).stat)
        throw new HttpError(409, 'exists', 'That name already exists.')
      const contents = await this.folderContents(from)
      // The new folder and its empty subfolders first: a folder with nothing to move still moves.
      await this.prepareParent(`${to}/x`)
      for (const rel of contents.folders)
        await fs.mkdir(path.join(this.root, ...`${to}${rel.slice(from.length)}`.split('/')), {
          recursive: true,
        })
      return contents
    })
    let moved = 0
    let updatedNotes = 0
    const skipped: MoveSkipped[] = []
    const leftBehind: Array<{ path: string; reason: string }> = unmanaged.map((rel) => ({
      path: rel,
      reason: 'A hidden file or a link: Knowledge leaves it alone.',
    }))
    for (const rel of files) {
      const dest = `${to}${rel.slice(from.length)}`
      try {
        if (/\.md$/i.test(rel)) {
          const result = await this.moveNote(rel, dest, updateLinks, author)
          updatedNotes += result.updatedNotes
          skipped.push(...result.skipped)
        } else if (isDocumentPath(rel)) await this.docs.move(rel, dest, author)
        else {
          leftBehind.push({ path: rel, reason: 'Not a note or a document Knowledge manages.' })
          continue
        }
        moved += 1
      } catch (error) {
        leftBehind.push({
          path: rel,
          reason: error instanceof Error ? error.message : 'Couldn’t move it.',
        })
      }
    }
    await this.serial(async () => {
      await this.pruneFolders(from, folders)
      await this.publish({ path: from, kind: 'moved', to, by: author })
    })
    return { path: to, moved, updatedNotes, skipped, leftBehind }
  },

  /**
   * Removes a folder. Without `contents`, only when nothing is in it. With `contents` (3.14.5, owner): every note (kept in
   * history, like any deleted note) and document inside is deleted first; a file Score doesn't manage stays, and so does
   * the folder that holds it.
   */
  async deleteFolderWithContents(
    this: VaultRuntime,
    input: string,
    author: KnowledgeAuthor = 'you',
  ): Promise<{ deleted: number; leftBehind: Array<{ path: string; reason: string }> }> {
    const segments = parseVaultPath(input)
    if (segments.some((segment) => segment.startsWith('.')))
      throw new HttpError(400, 'bad_path', 'Hidden files and folders are not part of Knowledge.')
    const folder = segments.join('/')
    const { files, folders, unmanaged } = await this.serial(async () => {
      const { stat } = await this.lookup(segments)
      if (!stat?.isDirectory()) throw new HttpError(404, 'not_found', 'Couldn’t find that folder.')
      return this.folderContents(folder)
    })
    let deleted = 0
    const leftBehind: Array<{ path: string; reason: string }> = unmanaged.map((rel) => ({
      path: rel,
      reason: 'A hidden file or a link: Knowledge leaves it alone.',
    }))
    for (const rel of files) {
      try {
        if (/\.md$/i.test(rel)) await this.deleteNote(rel, author)
        else if (isDocumentPath(rel)) await this.docs.delete(rel, author)
        else {
          leftBehind.push({ path: rel, reason: 'Not a note or a document Knowledge manages.' })
          continue
        }
        deleted += 1
      } catch (error) {
        leftBehind.push({
          path: rel,
          reason: error instanceof Error ? error.message : 'Couldn’t delete it.',
        })
      }
    }
    await this.serial(async () => {
      await this.pruneFolders(folder, folders)
      await this.publish({ path: folder, kind: 'deleted', to: null, by: author })
    })
    return { deleted, leftBehind }
  },

  /** Removes a folder only when nothing is in it. */
  async deleteFolder(this: VaultRuntime, input: string): Promise<void> {
    const segments = parseVaultPath(input)
    return this.serial(async () => {
      const { abs, stat } = await this.lookup(segments)
      if (!stat?.isDirectory()) throw new HttpError(404, 'not_found', 'Couldn’t find that folder.')
      if ((await fs.readdir(abs)).length > 0)
        throw new HttpError(409, 'not_empty', 'The folder isn’t empty.')
      await fs.rmdir(abs)
      await this.publish({ path: segments.join('/'), kind: 'deleted', to: null, by: 'you' })
    })
  },
}

export type FolderMethods = typeof folderMethods
