import { watch } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { KnowledgeChanged } from '@score/contract'
import { SEED_NOTES } from './seed.ts'
import { README } from './vault-types.ts'
import type { VaultRuntime } from './vault-runtime.ts'

export const lifecycleMethods = {
  serial<T>(this: VaultRuntime, work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  },

  /** Runs `work` under the vault lock (for the documents module). */
  runLocked<T>(this: VaultRuntime, work: () => Promise<T>): Promise<T> {
    return this.serial(work)
  },

  publishChange(this: VaultRuntime, change: KnowledgeChanged): Promise<void> {
    return this.publish(change)
  },

  async publish(this: VaultRuntime, change: KnowledgeChanged): Promise<void> {
    try {
      await this.options.emit(change)
    } catch (error) {
      this.options.log?.warn({ err: error }, 'Could not publish a knowledge change')
    }
  },

  // ---- lifecycle ---------------------------------------------------------------------------------------------

  /** Creates the vault on first use (`git init`, README.md, optional seed), indexes it, starts the watcher. */
  async start(this: VaultRuntime): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
    this.root = await fs.realpath(this.root)
    this.git.setVault(this.root)
    const hasGitDir = await fs
      .lstat(path.join(this.root, '.git'))
      .then(() => true)
      .catch(() => false)
    await this.git.init(hasGitDir)
    await this.serial(async () => {
      await this.migrateLegacyPlan().catch((error: unknown) =>
        this.options.log?.warn({ err: error }, 'Couldn’t move an old move plan'),
      )
      await this.recoverMove()
      const entries = (await fs.readdir(this.root)).filter((name) => name !== '.git')
      const fresh = entries.length === 0
      if (fresh) {
        await this.atomicWrite(path.join(this.root, 'README.md'), README)
        if (this.options.seed)
          for (const [rel, content] of Object.entries(SEED_NOTES)) {
            await fs.mkdir(path.dirname(path.join(this.root, rel)), { recursive: true })
            await this.atomicWrite(path.join(this.root, rel), content)
          }
      }
      if (this.git.available && !(await this.git.hasCommits()))
        await this.git.commit({
          paths: ['.'],
          message: 'Create vault',
          author: 'you',
        })
      await this.scan(false)
      await this.docs
        .reconcileHistory()
        .catch((error: unknown) =>
          this.options.log?.warn({ err: error }, 'Couldn’t check which documents are in history'),
        )
      await this.fillAuthors()
    })
    if (this.options.watch !== false) this.startWatching()
    this.interval = setInterval(
      () =>
        void this.serial(() => this.scan(true, true)).catch((error: unknown) =>
          this.logScan(error),
        ),
      this.options.scanIntervalMs ?? 5 * 60_000,
    )
    this.interval.unref()
  },

  logScan(this: VaultRuntime, error: unknown): void {
    this.options.log?.warn({ err: error }, 'Knowledge scan failed')
  },

  startWatching(this: VaultRuntime): void {
    const debounceMs = this.options.debounceMs ?? 400
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        // Git's own files change on every commit; hidden files are not part of the vault.
        if (
          filename &&
          String(filename)
            .split(path.sep)
            .some((part) => part.startsWith('.'))
        )
          return
        if (filename) this.dirty.add(String(filename).split(path.sep).join('/'))
        else this.verifyNext = true
        clearTimeout(this.debounce)
        this.debounce = setTimeout(
          () =>
            void this.serial(() => this.scan(true)).catch((error: unknown) => this.logScan(error)),
          debounceMs,
        )
      })
      this.watcher.on('error', (error) => {
        this.options.log?.warn(
          { err: error },
          'Knowledge watcher stopped; the periodic scan continues',
        )
        this.watcher?.close()
      })
    } catch (error) {
      this.options.log?.warn(
        { err: error },
        'Knowledge watcher unavailable; the periodic scan continues',
      )
    }
  },

  async close(this: VaultRuntime): Promise<void> {
    this.closed = true
    clearTimeout(this.debounce)
    clearInterval(this.interval)
    clearTimeout(this.retryTimer)
    this.watcher?.close()
    await this.queue.catch(() => undefined)
  },
}

export type LifecycleMethods = typeof lifecycleMethods
