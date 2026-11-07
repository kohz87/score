import path from 'node:path'
import type { FSWatcher } from 'node:fs'
import { VaultGit } from './git.ts'
import { KnowledgeDocuments } from './documents.ts'
import { installVaultMethods, type VaultPublicMethods } from './vault-runtime.ts'
import type { MoveIssue, VaultOptions } from './vault-types.ts'

export type {
  HistoryOutcome,
  MoveIssue,
  MoveSkipped,
  VaultLog,
  VaultOptions,
} from './vault-types.ts'

// The central vault (contract §12, design 6.0 § 6.2). Files are the source of truth; the DB only indexes them.
// Everything that changes files runs through one lock, so scans, saves and git never interleave. Nothing here is
// Hermes-specific.

const KnowledgeVaultCore = class KnowledgeVault {
  readonly git: VaultGit
  /** Uploaded documents (PLAN 6.6); share this vault's lock, git and index. */
  readonly docs: KnowledgeDocuments
  private root: string
  private readonly now: () => number
  private queue: Promise<unknown> = Promise.resolve()
  private watcher: FSWatcher | undefined
  private debounce: NodeJS.Timeout | undefined
  private interval: NodeJS.Timeout | undefined
  private closed = false
  private issue: MoveIssue | null = null
  private retryTimer: NodeJS.Timeout | undefined
  private retryDelayMs: number
  /** Paths the watcher reported since the last scan. */
  private dirty = new Set<string>()
  private verifyNext = false

  constructor(private readonly options: VaultOptions) {
    this.root = path.resolve(options.vault)
    this.now = options.now ?? Date.now
    this.retryDelayMs = options.moveRetryMs ?? 2000
    this.git = new VaultGit(this.root, this.now)
    this.docs = new KnowledgeDocuments(
      this as unknown as ConstructorParameters<typeof KnowledgeDocuments>[0],
      options.db,
    )
    // Stored-only documents (over 10 MB) are not in git, so "Outside changes" must not sweep them in.
    this.git.setIgnore(() => this.docs.unversionedPaths())
  }

  get vault(): string {
    return this.root
  }

  get gitAvailable(): boolean {
    return this.git.available
  }
}

installVaultMethods(KnowledgeVaultCore.prototype)

export type KnowledgeVault = InstanceType<typeof KnowledgeVaultCore> & VaultPublicMethods

type KnowledgeVaultConstructor = {
  new (options: VaultOptions): KnowledgeVault
  readonly prototype: KnowledgeVault
}

export const KnowledgeVault = KnowledgeVaultCore as unknown as KnowledgeVaultConstructor
