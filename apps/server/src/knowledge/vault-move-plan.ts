import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import { syncDir } from './move-file.ts'
import { hashContent } from './note.ts'
import { MAX_STORE_BYTES } from './doc-types.ts'
import {
  isNotFound,
  MovePlanSchema,
  type FileIdentity,
  type MoveIssue,
  type MovePlan,
  type MoveSkipped,
} from './vault-types.ts'
import type { VaultRuntime } from './vault-runtime.ts'

export const movePlanMethods = {
  // ---- move plan (roll-forward recovery) ---------------------------------------------------------------------

  /**
   * In Score's own state, keyed by the vault's real path: never inside the vault, so it is not swept into a commit or
   * walked as a note, and it works whatever the vault's layout (a linked Git worktree's `.git` is a file).
   */
  stateRoot(this: VaultRuntime): string {
    return this.options.stateDir ?? path.join(os.tmpdir(), 'score-knowledge-state')
  },

  planFile(this: VaultRuntime): string {
    const key = createHash('sha256').update(this.root).digest('hex').slice(0, 16)
    return path.join(this.stateRoot(), `move-plan-${key}.json`)
  },

  /** Reads the plan; null when there is none. Anything unreadable is reported to the caller as an error. */
  async readPlan(this: VaultRuntime, file: string): Promise<MovePlan | null> {
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      throw error
    }
    return MovePlanSchema.parse(JSON.parse(raw))
  },

  /**
   * Moves a plan an older version kept under `.git` into Score's state: copy, confirm the copy is on disk and parses,
   * and only then delete the old file. Only content that can never be read (a parse error) is discarded; any I/O
   * error leaves the old file for the next start, so a plan always survives somewhere.
   */
  async migrateLegacyPlan(this: VaultRuntime): Promise<void> {
    const legacy = path.join(this.root, '.git', 'score-move-plan.json')
    let raw: string
    try {
      raw = await fs.readFile(legacy, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return // none, or `.git` is a file (linked worktree)
      throw error
    }
    let plan: MovePlan
    try {
      plan = MovePlanSchema.parse(JSON.parse(raw))
    } catch (error) {
      this.options.log?.warn({ err: error }, 'Discarded an unreadable move plan')
      await fs.rm(legacy, { force: true })
      return
    }
    const target = this.planFile()
    const [legacyStat, targetStat] = await Promise.all([
      fs.stat(legacy),
      fs.stat(target).catch((error: unknown) => {
        if (isNotFound(error)) return null
        throw error
      }),
    ])
    let keepLegacy = targetStat === null
    if (targetStat !== null) {
      // Both exist: the newer file wins. An unreadable replacement doesn't count as a plan.
      const existing = await this.readPlan(target).catch((error: unknown) => {
        if (error instanceof SyntaxError || error instanceof z.ZodError) return null
        throw error
      })
      keepLegacy = existing === null || legacyStat.mtimeMs > targetStat.mtimeMs
    }
    if (keepLegacy) {
      await this.writePlanFile(plan)
      const back = await this.readPlan(target)
      if (back === null || JSON.stringify(back) !== JSON.stringify(plan))
        throw new Error('The migrated move plan could not be read back')
    }
    await fs.rm(legacy, { force: true })
  },

  /**
   * Written and flushed (file, then folder) before the caller changes anything in the vault, and again after each
   * step, so a plan on disk is never behind the files. Where the platform can't flush a folder, the file still is.
   */
  async writePlanFile(this: VaultRuntime, plan: MovePlan): Promise<void> {
    const dir = this.stateRoot()
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const file = this.planFile()
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await fs.open(temp, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(plan))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(temp, file)
    } catch (error) {
      await fs.rm(temp, { force: true })
      throw error
    }
    await syncDir(dir)
  },

  async savePlan(this: VaultRuntime, plan: MovePlan): Promise<void> {
    await this.writePlanFile(plan)
  },

  async clearPlan(this: VaultRuntime): Promise<void> {
    await fs.rm(this.planFile(), { force: true })
    await syncDir(this.stateRoot()).catch(() => undefined)
  },

  /** Writes one planned rewrite if the note is still the planned version. */
  async applyMoveItem(
    this: VaultRuntime,
    item: MovePlan['items'][number],
  ): Promise<'written' | 'conflict'> {
    const file = await this.lookup(item.path.split('/'))
    const current = file.stat?.isFile()
      ? await this.readContained(file.abs).then(hashContent, () => null)
      : null
    if (current === item.newHash) return 'written'
    if (current !== item.baseHash) return 'conflict'
    try {
      await this.atomicWrite(file.abs, item.content, { hash: item.baseHash }, true)
    } catch (error) {
      if (error instanceof HttpError && error.status === 412) return 'conflict'
      throw error
    }
    return 'written'
  },

  /**
   * The part of a move after the rename: applies the planned link rewrites (a note edited since is left alone),
   * commits, indexes and announces. A failure keeps the plan on disk for `recoverMove`. Every rewrite that was
   * recorded as done is checked again first: a note deleted or edited since (while Score was down, say) becomes a
   * skipped item, never a reason to fail.
   */
  async finishMove(
    this: VaultRuntime,
    plan: MovePlan,
  ): Promise<{ updated: number; skipped: MoveSkipped[] }> {
    const { from, to, author } = plan
    let failure: unknown
    try {
      for (const item of plan.items) {
        if (item.done) continue
        if ((await this.applyMoveItem(item)) === 'conflict') {
          this.options.log?.warn(
            { path: item.path },
            'A note changed while its links were being updated; its links were left as they are',
          )
          item.skipped = true
          item.reason = 'it changed while the links were being updated'
        }
        item.done = true
        await this.savePlan(plan)
      }
    } catch (error) {
      failure = error
    }
    for (const item of plan.items) {
      if (!item.done || item.skipped) continue
      const file = await this.lookup(item.path.split('/')).catch(() => null)
      const current = file?.stat?.isFile()
        ? await this.readContained(file.abs).then(hashContent, () => null)
        : null
      if (current === item.newHash) continue
      item.skipped = true
      item.reason = current === null ? 'it was removed' : 'it changed since the links were updated'
    }
    const rewritten = plan.items
      .filter((item) => item.done && !item.skipped)
      .map((item) => item.path)
    if (rewritten.length > 0)
      await this.commit([...new Set(rewritten)], `Update links after moving ${from}`, author)
    this.options.db.tx((sqlite) => this.remove(sqlite, from))
    await this.indexFile(to, author).catch((error: unknown) => {
      // The moved note was removed or replaced by something that isn't a note since; the next scan sorts it out.
      this.options.log?.warn({ err: error, path: to }, 'Couldn’t index a moved note')
    })
    for (const rel of rewritten) if (rel !== to) await this.indexFile(rel, author)
    await this.publish({ path: from, kind: 'moved', to, by: author })
    for (const rel of rewritten)
      if (rel !== to) await this.publish({ path: rel, kind: 'written', to: null, by: author })
    if (failure !== undefined) {
      this.options.log?.warn({ err: failure }, 'Updating links after a move failed; it will resume')
      throw new HttpError(
        500,
        'move_incomplete',
        `The note was moved, but some links in other notes could not be updated yet. Score finishes this on its next start or move.`,
      )
    }
    await this.clearPlan()
    return {
      updated: rewritten.filter((rel) => rel !== to).length,
      skipped: plan.items
        .filter((item) => item.skipped)
        .map((item) => ({ path: item.path, reason: item.reason ?? 'it changed' })),
    }
  },

  /** Identity of the file at `abs`: inode and birth time survive a rename, the content hash survives a copy. */
  async identityOf(this: VaultRuntime, abs: string, withHash = true): Promise<FileIdentity> {
    const st = await fs.lstat(abs)
    const hash = withHash ? await this.hashContained(abs, MAX_STORE_BYTES) : undefined
    return {
      dev: st.dev,
      ino: st.ino,
      birthtimeMs: st.birthtimeMs,
      size: st.size,
      ...(hash === undefined ? {} : { hash }),
    }
  },

  /** Whether the file at `abs` is the one `identity` describes. */
  async matchesIdentity(this: VaultRuntime, abs: string, identity: FileIdentity): Promise<boolean> {
    const st = await fs.lstat(abs).catch(() => null)
    if (!st?.isFile()) return false
    if (
      st.dev === identity.dev &&
      st.ino === identity.ino &&
      st.birthtimeMs === identity.birthtimeMs
    )
      return true
    if (identity.hash === undefined || st.size !== identity.size) return false
    const hash = await this.hashContained(abs, MAX_STORE_BYTES).catch(() => null)
    return hash !== null && hash === identity.hash
  },

  /** The move that needs attention, for the Knowledge page. */
  moveIssue(this: VaultRuntime): MoveIssue | null {
    return this.issue
  },

  /** Owner decision: abandon a conflicted (or stuck) plan. The files are left exactly as they are. */
  async dismissMoveIssue(this: VaultRuntime): Promise<void> {
    return this.serial(async () => {
      await this.clearPlan()
      this.setIssue(null)
    })
  },

  setIssue(this: VaultRuntime, issue: MoveIssue | null): void {
    this.issue = issue
    if (issue?.state !== 'pending') {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
      this.retryDelayMs = this.options.moveRetryMs ?? 2000
    }
  },

  scheduleRecoveryRetry(this: VaultRuntime): void {
    if (this.closed || this.retryTimer !== undefined) return
    const delay = this.retryDelayMs
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 5 * 60_000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.serial(() => this.recoverMove()).catch(() => undefined)
    }, delay)
    this.retryTimer.unref()
  },

  /**
   * Finishes a move that was interrupted after its plan was saved (caller holds the lock). Never throws, and the plan
   * only ends when the move is finished, was abandoned by the owner, or is proven untouched. A transient failure keeps
   * the plan, shows "move pending" and retries with backoff; a conflict keeps it and shows that instead; a plan that
   * can't be parsed is set aside as `.bad`.
   */
  async recoverMove(this: VaultRuntime): Promise<void> {
    try {
      await this.recoverMoveUnsafe()
    } catch (error) {
      this.options.log?.warn(
        { err: error },
        'Couldn’t finish an interrupted move; it will be retried',
      )
      const plan = await this.readPlan(this.planFile()).catch(() => null)
      if (plan === null) return
      this.setIssue({
        state: 'pending',
        from: plan.from,
        to: plan.to,
        message: 'A move is waiting to be finished; Score retries automatically.',
      })
      this.scheduleRecoveryRetry()
    }
  },

  async recoverMoveUnsafe(this: VaultRuntime): Promise<void> {
    let plan: MovePlan | null
    try {
      plan = await this.readPlan(this.planFile())
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error
      // Malformed: keep it for inspection, but it can't block Knowledge.
      this.options.log?.warn({ err: error }, 'Set aside an unreadable move plan')
      await fs.rename(this.planFile(), `${this.planFile()}.bad`)
      await syncDir(this.stateRoot()).catch(() => undefined)
      this.setIssue(null)
      return
    }
    if (plan === null) {
      this.setIssue(null)
      return
    }
    const conflict = async (detail: string): Promise<void> => {
      plan.state = 'conflicted'
      plan.detail = detail
      await this.savePlan(plan)
      this.options.log?.warn({ from: plan.from, to: plan.to, detail }, 'A move needs attention')
      this.setIssue({ state: 'conflicted', from: plan.from, to: plan.to, message: detail })
    }
    if (plan.state === 'conflicted') {
      this.setIssue({
        state: 'conflicted',
        from: plan.from,
        to: plan.to,
        message: plan.detail ?? 'An interrupted move could not be verified.',
      })
      return
    }
    if (plan.parked !== undefined) {
      await conflict(
        `A move from an older version of Score was interrupted. Look for a file named ${plan.parked} before dismissing this.`,
      )
      return
    }
    const target = await this.lookup(plan.to.split('/'))
    if (!target.stat) {
      // The rename is one atomic call and the destination was never created: nothing moved.
      await this.clearPlan()
      this.setIssue(null)
      return
    }
    const source = await this.lookup(plan.from.split('/'))
    const identity = plan.identity
    const targetIsMoved =
      identity === undefined ? !source.stat : await this.matchesIdentity(target.abs, identity)
    if (!targetIsMoved) {
      if (
        identity !== undefined &&
        source.stat &&
        (await this.matchesIdentity(source.abs, identity))
      ) {
        await this.clearPlan() // untouched: someone else's file sits at the destination
        this.setIssue(null)
        return
      }
      await conflict(
        `Score was moving ${plan.from} to ${plan.to}, but the file now at ${plan.to} is not the one that was being moved. Nothing was changed; check both names, then dismiss this.`,
      )
      return
    }
    this.setIssue(null)
    await this.commit([plan.from, plan.to], `Move ${plan.from} to ${plan.to}`, plan.author)
    await this.finishMove(plan)
  },
}

export type MovePlanMethods = typeof movePlanMethods
