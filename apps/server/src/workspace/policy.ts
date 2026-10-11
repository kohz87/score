import fs from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

// Path-safety policy for the Workspace (design 6.0 § 6.1 and review items 1, 2, 11). Pure helpers plus the root
// checks; the file operations that use them live in workspace.ts. Nothing here is Hermes-specific.

export class WorkspaceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

const MAX_PATH_CHARS = 4096
const MAX_NAME_BYTES = 255

// Names Score never lists, reads, writes or deletes, at any depth. Not a guarantee for arbitrarily named secret
// files; the UI says so.
const BLOCKED_PATTERNS: RegExp[] = [
  /^\.env/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /^id_ecdsa/i,
  /^id_dsa/i,
  /^auth\.json$/i,
  /^\.netrc$/i,
]

export function isBlockedName(name: string): boolean {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(name))
}

/** Names a recursive delete must never remove, at any depth: blocked names and any case of `.git`. */
export function isProtectedName(name: string): boolean {
  return isGitName(name) || isBlockedName(name)
}

export function isGitName(name: string): boolean {
  return name.toLowerCase() === '.git'
}

/**
 * Splits and validates a root-relative POSIX path. `''` (the root) yields no segments. Rejects NUL, absolute paths,
 * `..` segments and over-long input; ignores empty and `.` segments.
 */
export function parseRelativePath(input: string): string[] {
  if (input.length > MAX_PATH_CHARS)
    throw new WorkspaceError(400, 'bad_path', 'The path is too long.')
  if (input.includes('\0')) throw new WorkspaceError(400, 'bad_path', 'The path is invalid.')
  if (input.startsWith('/') || input.startsWith('\\') || /^[A-Za-z]:/.test(input))
    throw new WorkspaceError(400, 'bad_path', 'The path must be relative to the workspace folder.')
  const segments: string[] = []
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') throw new WorkspaceError(400, 'bad_path', 'The path can’t contain “..”.')
    if (Buffer.byteLength(segment) > MAX_NAME_BYTES)
      throw new WorkspaceError(400, 'bad_path', 'A path segment is too long.')
    segments.push(segment)
  }
  return segments
}

/** A single new entry name (create, rename target). */
export function validateEntryName(name: string): void {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\0') ||
    Buffer.byteLength(name) > MAX_NAME_BYTES
  )
    throw new WorkspaceError(400, 'bad_path', 'The name is invalid.')
}

export type PathUse = 'list' | 'read' | 'mutate'

/**
 * Applies the blocked list to a segment list (already resolved where symlinks are involved). `.git` may be
 * listed (as an entry of its parent, or its own top level) but nothing inside it may be touched, and `.git`
 * itself may not be changed.
 */
export function assertAllowedSegments(segments: readonly string[], use: PathUse): void {
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1
    if (isBlockedName(segment))
      throw new WorkspaceError(403, 'blocked', 'That path isn’t available.')
    if (isGitName(segment) && (!last || use === 'mutate'))
      throw new WorkspaceError(403, 'blocked', 'That path isn’t available.')
  })
}

export interface RootPolicy {
  /** The user's home folder. */
  home: string
  /** Folders that may never be a root or contain one (the agent runtime's home, Score's own home, ~/.ssh …). */
  forbidden: string[]
}

export function defaultRootPolicy(extraForbidden: Array<string | undefined> = []): RootPolicy {
  const home = homedir()
  return {
    home,
    forbidden: [
      path.join(home, '.score'),
      path.join(home, '.ssh'),
      ...extraForbidden.filter((item): item is string => Boolean(item)),
    ],
  }
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  // A child may be named "..backup"; only a real ".." segment leaves the parent.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

async function realOrSelf(target: string): Promise<string> {
  try {
    return await fs.realpath(target)
  } catch {
    return target
  }
}

/** Every forbidden folder in both lexical and resolved form. */
async function forbiddenForms(policy: RootPolicy): Promise<string[]> {
  const forms = new Set<string>()
  for (const folder of policy.forbidden) {
    forms.add(path.resolve(folder))
    forms.add(await realOrSelf(path.resolve(folder)))
  }
  return [...forms]
}

/** `~` and `~/x` expand to the user's home; everything else is returned as is. */
export function expandHome(input: string, home: string): string {
  if (input === '~') return home
  if (input.startsWith('~/')) return path.join(home, input.slice(2))
  return input
}

export type RootCheck = { ok: true; real: string } | { ok: false; reason: string }

/**
 * Whether `candidate` may be a workspace root: absolute, an existing directory owned by the current user,
 * not `/`, not the home folder or one of its ancestors, not a forbidden folder or inside one.
 */
export async function checkRoot(candidate: string, policy: RootPolicy): Promise<RootCheck> {
  const expanded = expandHome(candidate.trim(), policy.home)
  if (expanded === '' || expanded.includes('\0')) return { ok: false, reason: 'No folder is set.' }
  if (!path.isAbsolute(expanded))
    return { ok: false, reason: 'Use a full path, starting with / or ~.' }
  const lexical = path.resolve(expanded)
  let real: string
  try {
    const stat = await fs.stat(lexical)
    if (!stat.isDirectory()) return { ok: false, reason: 'That path is a file, not a folder.' }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      return { ok: false, reason: 'That folder belongs to another user.' }
    real = await fs.realpath(lexical)
  } catch {
    return { ok: false, reason: 'That folder doesn’t exist on this machine.' }
  }
  const home = await realOrSelf(path.resolve(policy.home))
  for (const form of new Set([lexical, real])) {
    // Inside .git (or another protected name) the root-relative checks would no longer see that component.
    if (form.split(path.sep).some((part) => isGitName(part) || isBlockedName(part)))
      return {
        ok: false,
        reason: 'A folder inside .git or a credential folder can’t be a workspace.',
      }
    if (form === path.parse(form).root)
      return { ok: false, reason: 'The whole file system can’t be a workspace.' }
    for (const homeForm of new Set([path.resolve(policy.home), home]))
      if (isInside(form, homeForm))
        return {
          ok: false,
          reason: 'The home folder (or a folder that contains it) can’t be a workspace.',
        }
    for (const blocked of await forbiddenForms(policy))
      if (isInside(blocked, form) || isInside(form, blocked))
        return {
          ok: false,
          reason: 'That folder holds Hermes, Score or SSH data and can’t be a workspace.',
        }
  }
  return { ok: true, real }
}
