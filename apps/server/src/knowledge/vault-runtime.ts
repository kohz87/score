import type { FSWatcher } from 'node:fs'
import type { KnowledgeDocuments } from './documents.ts'
import type { VaultGit } from './git.ts'
import type { MoveIssue, VaultOptions } from './vault-types.ts'
import { type FileMethods, fileMethods } from './vault-files.ts'
import { type FolderMethods, folderMethods } from './vault-folders.ts'
import { type IndexMethods, indexMethods } from './vault-index.ts'
import { type LifecycleMethods, lifecycleMethods } from './vault-lifecycle.ts'
import { type MovePlanMethods, movePlanMethods } from './vault-move-plan.ts'
import { type ReadMethods, readMethods } from './vault-reads.ts'
import { type WriteMethods, writeMethods } from './vault-writes.ts'

export interface VaultRuntime
  extends
    LifecycleMethods,
    FileMethods,
    IndexMethods,
    ReadMethods,
    WriteMethods,
    MovePlanMethods,
    FolderMethods {
  readonly git: VaultGit
  readonly docs: KnowledgeDocuments
  root: string
  readonly options: VaultOptions
  queue: Promise<unknown>
  watcher: FSWatcher | undefined
  debounce: NodeJS.Timeout | undefined
  interval: NodeJS.Timeout | undefined
  closed: boolean
  issue: MoveIssue | null
  retryTimer: NodeJS.Timeout | undefined
  retryDelayMs: number
  /** Paths the watcher reported since the last scan. */
  dirty: Set<string>
  verifyNext: boolean
}

type WithoutThis<T> = T extends (this: VaultRuntime, ...args: infer Args) => infer Result
  ? (...args: Args) => Result
  : never

type PublicMethods<T, K extends keyof T> = { [P in K]: WithoutThis<T[P]> }

export type VaultPublicMethods = {
  runLocked<T>(work: () => Promise<T>): Promise<T>
} & PublicMethods<LifecycleMethods, 'publishChange' | 'start' | 'close'> &
  PublicMethods<
    FileMethods,
    | 'lookup'
    | 'prepareParent'
    | 'atomicWrite'
    | 'moveNoReplace'
    | 'readContainedBuffer'
    | 'hashContained'
    | 'readContainedRange'
    | 'openContainedStream'
  > &
  PublicMethods<IndexMethods, 'rebuild' | 'scanNow'> &
  PublicMethods<
    ReadMethods,
    | 'agentAccess'
    | 'memoryNotes'
    | 'setMemoryNotes'
    | 'setAgentAccess'
    | 'info'
    | 'tree'
    | 'readNote'
    | 'search'
    | 'history'
    | 'version'
  > &
  PublicMethods<
    WriteMethods,
    | 'commitOutside'
    | 'commitPaths'
    | 'ignoredUntracked'
    | 'indexNote'
    | 'writeNote'
    | 'moveNote'
    | 'deleteNote'
    | 'restoreNote'
  > &
  PublicMethods<MovePlanMethods, 'planFile' | 'moveIssue' | 'dismissMoveIssue'> &
  PublicMethods<
    FolderMethods,
    'createFolder' | 'moveFolder' | 'deleteFolderWithContents' | 'deleteFolder'
  >

const vaultMethods = {
  ...lifecycleMethods,
  ...fileMethods,
  ...indexMethods,
  ...readMethods,
  ...writeMethods,
  ...movePlanMethods,
  ...folderMethods,
}

/** Installs the vault's method modules on the class prototype with class-method descriptors. */
export function installVaultMethods(prototype: object): void {
  for (const [name, method] of Object.entries(vaultMethods)) {
    Object.defineProperty(prototype, name, {
      value: method,
      writable: true,
      enumerable: false,
      configurable: true,
    })
  }
}
