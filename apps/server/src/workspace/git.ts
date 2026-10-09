import { execFile } from 'node:child_process'

export interface GitStatus {
  branch: string
  changed: number
  ahead: number
  behind: number
}

// Read-only look at the repository around a workspace root. Only `git status` runs, with the options that keep it
// from writing (no index refresh lock) or from running anything configured in the repository (fsmonitor hook).
const ARGS = [
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-C',
]
const TIMEOUT_MS = 5000
const MAX_OUTPUT = 8 * 1024 * 1024

/** Parses `git status --porcelain=v1 -b` output; exported for tests. */
export function parseGitStatus(output: string): GitStatus | null {
  const lines = output.split('\n').filter((line) => line !== '')
  const head = lines.find((line) => line.startsWith('## '))
  if (head === undefined) return null
  const changed = lines.filter((line) => !line.startsWith('## ')).length
  let text = head.slice(3)
  let ahead = 0
  let behind = 0
  const counts = /\s\[([^\]]*)\]$/.exec(text)
  if (counts) {
    text = text.slice(0, counts.index)
    ahead = Number(/ahead (\d+)/.exec(counts[1]!)?.[1] ?? 0)
    behind = Number(/behind (\d+)/.exec(counts[1]!)?.[1] ?? 0)
  }
  let branch = text.split('...')[0]!
  const fresh = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(branch)
  if (fresh) branch = fresh[1]!
  else if (branch.startsWith('HEAD (no branch)')) branch = 'detached HEAD'
  return { branch: branch.slice(0, 200), changed, ahead, behind }
}

// Settings that make git run a program of the repository's choosing while it compares files or reads the index.
const RISKY_CONFIG =
  /^(?:filter\.|core\.fsmonitor$|core\.hookspath$|core\.sshcommand$|core\.askpass$|core\.editor$|core\.pager$|diff\.[^\0]*\.(?:textconv|command)$|include\.|includeif\.)/i

/** Git's environment for these calls: no inherited GIT_* variables and no system or user configuration. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env))
    if (!name.startsWith('GIT_')) env[name] = value
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  }
}

function run(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, env: gitEnv() },
      (error, stdout) => resolve(error ? null : stdout),
    )
  })
}

/** True when the repository's own configuration could make git execute something (filters, hooks, textconv, includes). */
export function configIsRisky(listing: string): boolean {
  return listing.split('\0').some((entry) => RISKY_CONFIG.test(entry.split('\n')[0] ?? ''))
}

/**
 * Branch and change count when `root` (or a parent) is a git repository, else null. Never throws. A repository whose
 * local configuration defines filters, fsmonitor, a hooks path, textconv or includes is reported as unavailable
 * rather than run: comparing files would execute them under Score's user.
 */
export async function gitStatus(root: string): Promise<GitStatus | null> {
  const config = await run(['-C', root, 'config', '--local', '--list', '-z'])
  if (config === null || configIsRisky(config)) return null
  const stdout = await run([
    ...ARGS,
    root,
    'status',
    '--porcelain=v1',
    '-b',
    '--untracked-files=all',
    '--ignore-submodules=all',
  ])
  return stdout === null ? null : parseGitStatus(stdout)
}
