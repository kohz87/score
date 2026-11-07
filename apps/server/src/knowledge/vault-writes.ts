import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type {
  KnowledgeAuthor,
  KnowledgeHistoryStatus,
  KnowledgeWriteRequest,
} from '@score/contract'
import { buildNoteIndex, rewriteLinks } from './links.ts'
import {
  etagOf,
  hashContent,
  MAX_NOTE_BYTES,
  parseNote,
  parseNotePath,
  serialiseNote,
} from './note.ts'
import { prepareNoteContent } from './note-images.ts'
import { HttpError } from '../errors.ts'
import {
  historyOutcome,
  type HistoryOutcome,
  type MovePlan,
  type MoveSkipped,
} from './vault-types.ts'
import type { VaultRuntime } from './vault-runtime.ts'

export const writeMethods = {
  // ---- writes ------------------------------------------------------------------------------------------------

  /** Commits whatever changed behind Score's back before Score's own commit. */
  async commitOutside(this: VaultRuntime): Promise<void> {
    try {
      await this.git.commitOutsideChanges()
    } catch (error) {
      // Without that snapshot an overwrite or delete could destroy an outside edit that never reached history.
      this.options.log?.warn(
        { err: error },
        'Could not record outside changes in the vault history',
      )
      throw new HttpError(
        503,
        'git_unavailable',
        'Knowledge history isn’t working (git failed), so notes can’t be changed safely. Fix the git repository in the Knowledge folder and try again.',
      )
    }
  },

  /** Commits paths for the documents module (same author and failure rules as notes). */
  async commitPaths(
    this: VaultRuntime,
    paths: string[],
    message: string,
    author: KnowledgeAuthor,
  ): Promise<HistoryOutcome> {
    return this.commit(paths, message, author)
  },

  /** The given paths that are Git-ignored and untracked (the documents module classifies with this). */
  ignoredUntracked(this: VaultRuntime, paths: string[]): Promise<Set<string>> {
    return this.git.ignoredUntracked(paths)
  },

  /** Indexes a note file Score has just written itself. */
  async indexNote(this: VaultRuntime, rel: string, author: KnowledgeAuthor): Promise<void> {
    await this.indexFile(rel, author)
  },

  /**
   * Commits what Score changed and says what happened to history. Ignored, untracked paths are left out (never
   * force-added, decision 80) and reported as `not_versioned`; a missing git is `git_unavailable`; any other git
   * failure is logged and reported as `failed`. The files are saved in every case. Calling it again for content that
   * is already in history answers `unchanged`; for content whose commit failed it commits (a repair).
   */
  async commit(
    this: VaultRuntime,
    paths: string[],
    message: string,
    author: KnowledgeAuthor,
    amendNote?: string,
  ): Promise<HistoryOutcome> {
    if (!this.git.available) return historyOutcome('git_unavailable')
    try {
      const ignored = await this.git.ignoredUntracked(paths)
      const rest = paths.filter((path) => !ignored.has(path))
      if (rest.length === 0) return historyOutcome('not_versioned')
      const sha = await this.git.commit({
        paths: rest,
        message,
        author,
        ...(amendNote && !ignored.has(amendNote) ? { amendNote } : {}),
      })
      return historyOutcome(sha === null ? 'unchanged' : 'committed', ignored.size > 0)
    } catch (error) {
      // The files are saved; history can catch up with the next "Outside changes" commit.
      this.options.log?.warn({ err: error }, 'Could not commit a knowledge change')
      return historyOutcome('failed')
    }
  },

  /**
   * Where a note stands in history, as a read finds it: no working git is `git_unavailable` (never "versioned"); a
   * Git-ignored, untracked path is `not_versioned`; a file that differs from the last commit, or whose state Git can't tell, is `failed` (the editor
   * keeps offering "Save to history again" across a reload); otherwise the content is already in history.
   */
  async historyOf(
    this: VaultRuntime,
    rel: string,
  ): Promise<{ versioned: boolean; history: KnowledgeHistoryStatus }> {
    if (!this.git.available) return { versioned: false, history: 'git_unavailable' }
    if ((await this.git.ignoredUntracked([rel])).has(rel))
      return { versioned: false, history: 'not_versioned' }
    // Unknown (Git itself failed) keeps `failed`: the retry stays on offer until history can be verified.
    return {
      versioned: true,
      history: (await this.git.pathState(rel)) === 'clean' ? 'unchanged' : 'failed',
    }
  },

  /** Save a note (create with `etag: null`). `author` is `'you'` for the browser; 6.4 passes the calling agent. */
  async writeNote(
    this: VaultRuntime,
    input: string,
    request: KnowledgeWriteRequest,
    author: KnowledgeAuthor = 'you',
    /** Uploads: `request.body` is the whole file (frontmatter included), written byte for byte. */
    rawContent = false,
  ): Promise<{ etag: string; path: string } & HistoryOutcome> {
    const rel = parseNotePath(input)
    return this.serial(async () => {
      const { abs: existingAbs, stat } = await this.lookup(rel.split('/'))
      let current: ReturnType<typeof parseNote> | null = null
      let currentHash: string | null = null
      if (stat) {
        const raw = await this.readRaw(existingAbs, stat)
        current = parseNote(raw)
        currentHash = hashContent(raw)
      }
      if (request.etag === null && stat)
        throw new HttpError(409, 'exists', 'A note with that name already exists.')
      if (request.etag !== null) {
        if (currentHash === null)
          throw new HttpError(412, 'precondition_failed', 'The note was removed.', { etag: null })
        if (etagOf(currentHash) !== request.etag)
          throw new HttpError(412, 'precondition_failed', 'The note changed after you opened it.', {
            etag: etagOf(currentHash),
          })
      }
      const content = rawContent
        ? request.body
        : request.frontmatter === undefined
          ? (current?.prefix ?? '') + request.body
          : serialiseNote(request.body, request.frontmatter)
      prepareNoteContent(content)
      const hash = hashContent(content)
      if (hash === currentHash) {
        // Nothing to write, but a commit that failed earlier is still owed: try it again before answering.
        const repaired = await this.commit([rel], `${stat ? 'Update' : 'Create'} ${rel}`, author)
        return { etag: etagOf(hash), path: rel, ...repaired }
      }
      await this.commitOutside()
      const abs = await this.prepareParent(rel)
      // An outside edit that landed since the etag check is now in history; the save must not silently replace it.
      await this.atomicWrite(abs, content, { hash: currentHash })
      const history = await this.commit([rel], `${stat ? 'Update' : 'Create'} ${rel}`, author, rel)
      await this.indexFile(rel, author)
      await this.publish({ path: rel, kind: 'written', to: null, by: author })
      // A memory note's weight or a new memory note changes its month's list (PLAN 8.2); the save stands either way.
      await this.refreshMemoryIndexes([rel], author)
      return { etag: etagOf(hash), path: rel, ...history }
    })
  },

  async moveNote(
    this: VaultRuntime,
    fromInput: string,
    toInput: string,
    updateLinks: boolean,
    author: KnowledgeAuthor = 'you',
  ): Promise<{ path: string; updatedNotes: number; skipped: MoveSkipped[] }> {
    const from = parseNotePath(fromInput)
    const to = parseNotePath(toInput)
    return this.serial(async () => {
      await this.recoverMove()
      if (this.issue !== null)
        throw new HttpError(
          409,
          'move_pending',
          this.issue.state === 'conflicted'
            ? 'An earlier move needs your attention first (see the notice on the Knowledge page).'
            : 'An earlier move is still being finished. Try again in a moment.',
        )
      const source = await this.lookup(from.split('/'))
      if (!source.stat?.isFile()) throw new HttpError(404, 'not_found', 'Couldn’t find that note.')
      if (from === to) throw new HttpError(409, 'exists', 'A note with that name already exists.')
      const target = await this.lookup(to.split('/'))
      if (target.stat) throw new HttpError(409, 'exists', 'A note with that name already exists.')
      await this.commitOutside()
      // Notes or links added outside Score since the last scan must take part in the rewrite.
      await this.scan(true)
      const paths = this.options.db.read((sqlite) => this.noteRows(sqlite).map((row) => row.path))
      const before = buildNoteIndex(paths)
      const after = buildNoteIndex([...paths.filter((item) => item !== from), to])
      const linking = updateLinks
        ? this.options.db.read((sqlite) =>
            sqlite
              .prepare('SELECT DISTINCT from_path FROM knowledge_links WHERE to_path = ?')
              .all(from)
              .map((row) => z.object({ from_path: z.string() }).parse(row).from_path),
          )
        : []
      // Work out every rewrite first: a result over the size limit must refuse the whole move, not leave a note
      // that opens with 413 behind.
      const plan: Array<{ now: string; content: string; baseHash: string }> = []
      for (const old of linking) {
        const file = await this.lookup(old.split('/'))
        if (!file.stat?.isFile()) continue
        const raw = await this.readRaw(file.abs, file.stat)
        const parsed = parseNote(raw)
        const result = rewriteLinks(parsed.body, old, from, to, before, after)
        if (result.count === 0) continue
        const content = parsed.prefix + result.text
        if (Buffer.byteLength(content) > MAX_NOTE_BYTES)
          throw new HttpError(
            413,
            'payload_too_large',
            `Updating the links in ${old} would make that note too large. Nothing was moved.`,
          )
        plan.push({ now: old === from ? to : old, content, baseHash: hashContent(raw) })
      }
      const abs = await this.prepareParent(to)
      const identity = await this.identityOf(source.abs)
      const movePlan: MovePlan = {
        from,
        to,
        author,
        state: 'active',
        identity,
        items: plan.map((item) => ({
          path: item.now,
          baseHash: item.baseHash,
          newHash: hashContent(item.content),
          content: item.content,
          done: false,
          skipped: false,
        })),
      }
      // Written before anything moves: if Score stops half way, the next start finishes (or drops) the rewrites.
      await this.savePlan(movePlan)
      try {
        const moved = await this.moveNoReplace(source.abs, abs)
        if (!moved.synced)
          this.options.log?.warn({ from, to }, 'Couldn’t flush the folders after a move')
      } catch (error) {
        // One atomic call: when it failed with a definite answer nothing moved and the plan ends. Anything else
        // (a killed helper, say) is settled by looking at the files, never by assuming.
        if (
          error instanceof HttpError &&
          (error.code === 'exists' ||
            error.code === 'not_found' ||
            error.code === 'rename_unsupported')
        )
          await this.clearPlan()
        else await this.recoverMove()
        throw error
      }
      // What was actually moved (the file may have been saved again after the plan was written): recovery compares
      // the destination with this, not with the older identity.
      try {
        movePlan.identity = await this.identityOf(abs, false)
        await this.savePlan(movePlan)
      } catch (error) {
        this.options.log?.warn({ err: error }, 'Couldn’t record the moved note’s identity')
      }
      await this.assertParent(path.dirname(abs))
      // The rename gets a commit of its own: with the link edits in the same commit a short note can look like a
      // delete plus a create to git, and its earlier versions would no longer be found.
      await this.commit([from, to], `Move ${from} to ${to}`, author)
      const done = await this.finishMove(movePlan)
      return { path: to, updatedNotes: done.updated, skipped: done.skipped }
    })
  },

  /** Owner only: agents have no delete. */
  async deleteNote(
    this: VaultRuntime,
    input: string,
    author: KnowledgeAuthor = 'you',
  ): Promise<void> {
    const rel = parseNotePath(input)
    return this.serial(async () => {
      const { abs, stat } = await this.lookup(rel.split('/'))
      if (!stat?.isFile()) throw new HttpError(404, 'not_found', 'Couldn’t find that note.')
      await this.commitOutside()
      await fs.unlink(abs)
      await this.commit([rel], `Delete ${rel}`, author)
      this.options.db.tx((sqlite) => {
        this.remove(sqlite, rel)
        this.relink(sqlite)
      })
      await this.publish({ path: rel, kind: 'deleted', to: null, by: author })
    })
  },

  /** Writes the version at `commit` back as a new commit (history is never rewritten). */
  async restoreNote(
    this: VaultRuntime,
    input: string,
    commit: string,
    author: KnowledgeAuthor = 'you',
  ): Promise<{ etag: string; path: string }> {
    const rel = parseNotePath(input)
    return this.serial(async () => {
      const raw = await this.git.version(rel, commit)
      if (raw === null) throw new HttpError(404, 'not_found', 'Couldn’t find that version.')
      if (Buffer.byteLength(raw) > MAX_NOTE_BYTES)
        throw new HttpError(413, 'payload_too_large', 'That version is too large.')
      const { stat } = await this.lookup(rel.split('/'))
      if (stat && !stat.isFile()) throw new HttpError(400, 'not_a_note', 'That isn’t a note.')
      await this.commitOutside()
      const abs = await this.prepareParent(rel)
      await this.atomicWrite(abs, raw)
      await this.commit([rel], `Restore ${rel} to ${commit.slice(0, 7)}`, author)
      const { hash } = await this.indexFile(rel, author)
      await this.publish({ path: rel, kind: 'restored', to: null, by: author })
      return { etag: etagOf(hash), path: rel }
    })
  },
}

export type WriteMethods = typeof writeMethods
