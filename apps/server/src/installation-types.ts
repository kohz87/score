export interface RegistryPath {
  path: string
  state: 'current' | 'moved'
  at: string
}

export interface RegistryEntry {
  createdAt: string
  copiedFrom?: string
  paths: RegistryPath[]
}

export type Installations = Record<string, RegistryEntry>

export interface Manifest {
  version: 1
  id: string
  paths: string[]
  /** The path the installation lives at now. Stored, not inferred from the array's order: A → B → A leaves [A, B]. */
  current?: string
  createdAt: string
  copiedFrom?: string
}

export type Registry =
  | { state: 'missing' }
  | { state: 'corrupt'; reason: string }
  | { state: 'ok'; installations: Installations }

export type HomeFile = { state: 'missing' } | { state: 'corrupt' } | { state: 'ok'; id: string }

export type InstallationProblem =
  'registry_corrupt' | 'ambiguous_path' | 'id_conflict' | 'unconfirmed_path' | 'moved_away'

export type InstallationResult =
  | {
      ok: true
      id: string
      namespaceDir: string
      /** How the id was obtained: it was already agreed, recovered from the registry/manifests/legacy cutover, adopted
       * from the home's own copy, or newly minted. */
      how: 'existing' | 'recovered' | 'adopted' | 'created'
      /** Set when the registry says this installation was confirmed as a copy of another one. */
      copiedFrom?: string
    }
  | { ok: false; code: InstallationProblem; message: string; id?: string }

export interface ResolveOptions {
  journalDir: string
  home: string
  now?: () => string
  mintId?: () => string
}

export type ConfirmResult =
  { ok: true; id: string; changed: boolean; message: string } | { ok: false; message: string }
