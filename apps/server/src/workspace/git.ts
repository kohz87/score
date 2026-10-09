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

/** Branch and change count when `root` (or a parent) is a git repository, else null. Never throws. */
export function gitStatus(root: string): Promise<GitStatus | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...ARGS, root, 'status', '--porcelain=v1', '-b'],
      {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      },
      (error, stdout) => resolve(error ? null : parseGitStatus(stdout)),
    )
  })
}
