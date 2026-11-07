import type { CodingPermission, CodingRuntime } from '@score/contract'

export const permissionLabels: Record<CodingPermission, string> = {
  'read-only': 'Read only: looks at files, changes nothing',
  'workspace-write': 'Workspace write: edits files in its workspace (default)',
  full: 'Full access: no sandbox, runs anything as you',
}

/** Whether this CLI can read files outside its workspace at this level (then adding it needs an acknowledgement). */
export function readsOutsideWorkspace(
  runtime: CodingRuntime,
  permission: CodingPermission,
): boolean {
  if (runtime === 'codex') return true
  if (runtime === 'antigravity') return permission === 'full'
  return false
}

/** The short name used in "not verified for agy yet". */
export const shortNames: Partial<Record<CodingRuntime, string>> = { antigravity: 'agy' }

export const shortPermission: Record<CodingPermission, string> = {
  'read-only': 'read only',
  'workspace-write': 'workspace write',
  full: 'full access',
}

export const permissionNames: Record<CodingPermission, string> = {
  'read-only': 'Read only',
  'workspace-write': 'Workspace write',
  full: 'Full access',
}

export const permissionMeaning: Record<CodingPermission, string> = {
  'read-only': 'Looks at files, changes nothing.',
  'workspace-write': 'Edits files in its own workspace.',
  full: 'No sandbox: runs anything as you.',
}
