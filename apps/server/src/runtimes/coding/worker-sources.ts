import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** Why a CLI's configuration locations can't be worked out: the reach of the CLI can't be verified. */
export class PolicyUnverifiable extends Error {}

/** `dir` and every parent up to the file system root: where a CLI looks for per-folder instructions. */
export function ancestors(dir: string): string[] {
  const chain: string[] = []
  for (let at = dir; ; at = dirname(at)) {
    chain.push(at)
    if (dirname(at) === at) break
  }
  return chain
}

/** The same file name in every folder of the chain. */
export const inChain = (dir: string, ...parts: string[]): string[] =>
  ancestors(dir).map((folder) => join(folder, ...parts))

/** At most this much of a Git pointer file (`.git` file, `commondir`) is read. */
const GIT_POINTER_BYTES = 4096

/**
 * One line of Git metadata (never CLI configuration): the file, or undefined when it isn't there. A link is never
 * followed (F2 #2): `lstat` first (a regular file of this user, small), then `O_NOFOLLOW`, then the same file again by
 * identity, so a `commondir` that links to a CLI configuration file is refused without being opened.
 */
function gitPointer(path: string): string | undefined {
  const unverifiable = () => new PolicyUnverifiable(`Score can’t check the Git folder ${path}.`)
  let before
  try {
    before = lstatSync(path, { throwIfNoEntry: false })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOTDIR') return undefined
    throw new PolicyUnverifiable(
      `Score can’t check the Git folder ${path} (${code ?? 'unreadable'}).`,
    )
  }
  if (!before) return undefined
  const uid = process.getuid?.()
  if (
    !before.isFile() ||
    // A hard link could make a CLI config or credential file look like a Git pointer: only a file with one name is
    // opened (F2 verification #2).
    before.nlink !== 1 ||
    before.size > GIT_POINTER_BYTES ||
    (uid !== undefined && before.uid !== uid)
  )
    throw unverifiable()
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw new PolicyUnverifiable(
      `Score can’t check the Git folder ${path} (${code ?? 'unreadable'}).`,
    )
  }
  try {
    const stat = fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > GIT_POINTER_BYTES ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev
    )
      throw unverifiable()
    const buffer = Buffer.alloc(GIT_POINTER_BYTES)
    return buffer.subarray(0, readSync(fd, buffer, 0, GIT_POINTER_BYTES, 0)).toString('utf8')
  } catch (error) {
    if (error instanceof PolicyUnverifiable) throw error
    throw unverifiable()
  } finally {
    closeSync(fd)
  }
}

/** A Git folder a pointer names must exist, be a folder, and hold a `HEAD` (stat only: nothing is read). */
function requireGitDir(dir: string): void {
  try {
    if (statSync(dir).isDirectory() && statSync(join(dir, 'HEAD')).isFile()) return
  } catch {
    // falls through
  }
  throw new PolicyUnverifiable(`Score can’t find the Git folder ${dir}.`)
}

/**
 * The main checkout when `workspace` is inside a linked Git worktree (Claude Code and Codex look for project
 * configuration there too), or undefined for an ordinary checkout or no Git at all. Only Git's own metadata is read: the
 * `.git` pointer file and the `commondir` file. A worktree whose main checkout can't be located throws.
 */
export function mainCheckoutOf(workspace: string): string | undefined {
  for (const folder of ancestors(workspace)) {
    const dotGit = join(folder, '.git')
    let stat
    try {
      stat = lstatSync(dotGit, { throwIfNoEntry: false })
    } catch (error) {
      throw new PolicyUnverifiable(
        `Score can’t check ${dotGit} (${(error as NodeJS.ErrnoException).code ?? 'unreadable'}).`,
      )
    }
    if (!stat) continue
    if (stat.isDirectory()) return undefined
    if (!stat.isFile()) throw new PolicyUnverifiable(`Score can’t check ${dotGit}.`)
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(gitPointer(dotGit) ?? '')?.[1]
    if (!pointer) throw new PolicyUnverifiable(`Score can’t read where ${dotGit} points.`)
    const gitDir = resolve(folder, pointer)
    requireGitDir(gitDir)
    const common = gitPointer(join(gitDir, 'commondir'))?.trim()
    // No `commondir`: the pointed-to folder is the repository itself (not a linked worktree).
    const commonDir = common ? resolve(gitDir, common) : gitDir
    requireGitDir(commonDir)
    if (basename(commonDir) !== '.git')
      throw new PolicyUnverifiable(`Score can’t find the main checkout of ${workspace}.`)
    const main = dirname(commonDir)
    return main === folder ? undefined : main
  }
  return undefined
}

/** The workspace and, in a linked worktree, the main checkout: the roots a CLI reads project configuration from. */
export const configRoots = (workspace: string): string[] => {
  const main = mainCheckoutOf(workspace)
  return main === undefined ? [workspace] : [workspace, main]
}

/** The same path under each configuration root, with each root's ancestors. */
export const inRoots = (workspace: string, ...parts: string[]): string[] =>
  configRoots(workspace).flatMap((root) => inChain(root, ...parts))
