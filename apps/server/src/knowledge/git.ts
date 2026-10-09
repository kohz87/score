import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { KnowledgeAuthor, KnowledgeCommit } from '@score/contract'
import { authorFromGit, authorToColumn, gitIdentity, sameAuthor } from './note.ts'

const run = promisify(execFile)

export const AMEND_WINDOW_MS = 60_000

interface LastCommit {
  sha: string
  author: KnowledgeAuthor
  /** Set for single-note saves only; moves, deletes and restores never amend. */
  notePath: string
  at: number
}

export interface CommitOptions {
  /** Paths (vault-relative) to commit; deletions included. */
  paths: string[]
  message: string
  author: KnowledgeAuthor
  /** Allows amending Score's own last commit for this note (rapid edits within 60 s). */
  amendNote?: string
}

// Git for the vault (design 6.0 § 6.2, review item 7). Every call is `git -C <vault>` through execFile with an
// argument array. History is never rewritten except amending Score's own last commit within the window. Callers
// serialise calls (the vault's lock); nothing here is Hermes-specific.
export class VaultGit {
  available = false
  private last: LastCommit | undefined

  constructor(
    private vault: string,
    private readonly now: () => number = Date.now,
  ) {}

  private async git(args: string[], options: { author?: KnowledgeAuthor } = {}): Promise<string> {
    const identity = gitIdentity(options.author ?? 'you')
    const { stdout } = await run(
      'git',
      [
        '-C',
        this.vault,
        '-c',
        'core.quotepath=off',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.autocrlf=false',
        ...args,
      ],
      {
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60_000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_LITERAL_PATHSPECS: '1',
          GIT_AUTHOR_NAME: identity.name,
          GIT_AUTHOR_EMAIL: identity.email,
          GIT_COMMITTER_NAME: identity.name,
          GIT_COMMITTER_EMAIL: identity.email,
        },
      },
    )
    return stdout
  }

  /** Detects git, creates the repository when the vault has none, and makes the first commit. */
  async init(hasGitDir: boolean): Promise<boolean> {
    this.available = false
    try {
      await run('git', ['--version'])
      if (!hasGitDir) await this.git(['init', '-q'])
      const top = await this.git(['rev-parse', '--show-toplevel'])
      // A vault inside another repository would commit into it: refuse rather than guess.
      if ((await realpath(top.trim())) !== (await realpath(this.vault))) return false
      this.available = true
      return true
    } catch {
      return false
    }
  }

  setVault(vault: string): void {
    this.vault = vault
  }

  async hasCommits(): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--verify', '-q', 'HEAD'])
      return true
    } catch {
      return false
    }
  }

  /** Paths with uncommitted changes (modified, deleted or untracked). */
  private async dirty(): Promise<string[]> {
    const out = await this.git(['status', '--porcelain=v1', '-z', '-uall', '--no-renames'])
    return out
      .split('\0')
      .filter((entry) => entry.length > 3)
      .map((entry) => entry.slice(3))
  }

  /**
   * Commits whatever changed outside Score as "Outside changes", so Score's own commit contains only its own
   * change. Returns true when something was committed.
   */
  async commitOutsideChanges(): Promise<boolean> {
    if (!this.available) return false
    try {
      const paths = await this.dirty()
      if (paths.length === 0) return false
      await this.git(['add', '-A', '--', ...paths])
      await this.git(['commit', '-q', '--no-verify', '-m', 'Outside changes', '--', ...paths], {
        author: 'outside',
      })
      this.last = undefined
      return true
    } catch {
      return false
    }
  }

  /** Commits (or amends) the given paths. Resolves to the commit hash, or null when nothing changed or git failed. */
  async commit(options: CommitOptions): Promise<string | null> {
    if (!this.available) return null
    const { paths, message, author, amendNote } = options
    await this.git(['add', '-A', '--', ...paths])
    const staged = await this.git(['diff', '--cached', '--name-only', '--', ...paths])
    if (staged.trim() === '') return null
    const head = (await this.git(['rev-parse', 'HEAD']).catch(() => '')).trim()
    const amend =
      amendNote !== undefined &&
      this.last !== undefined &&
      this.last.sha === head &&
      this.last.notePath === amendNote &&
      sameAuthor(this.last.author, author) &&
      this.now() - this.last.at < AMEND_WINDOW_MS
    const identity = gitIdentity(author)
    await this.git(
      [
        'commit',
        '-q',
        '--no-verify',
        ...(amend ? ['--amend'] : []),
        `--author=${identity.name} <${identity.email}>`,
        '-m',
        amend ? (await this.git(['log', '-1', '--format=%s'])).trim() : message,
        '--',
        ...paths,
      ],
      { author },
    )
    const sha = (await this.git(['rev-parse', 'HEAD'])).trim()
    this.last =
      amendNote === undefined ? undefined : { sha, author, notePath: amendNote, at: this.now() }
    return sha
  }

  /** Newest first, following renames. `at` is the commit time. */
  async history(notePath: string): Promise<Array<KnowledgeCommit & { path: string }>> {
    if (!this.available) return []
    let out: string
    try {
      out = await this.git([
        'log',
        '--follow',
        '-n',
        '200',
        '--name-only',
        '--format=%x1e%H%x1f%cI%x1f%an%x1f%ae%x1f%s%x1f',
        '--',
        notePath,
      ])
    } catch {
      return [] // no commits yet
    }
    const items: Array<KnowledgeCommit & { path: string }> = []
    for (const record of out.split('\x1e')) {
      if (record.trim() === '') continue
      const [commit, at, name, email, message, rest] = record.split('\x1f')
      if (!commit || !at) continue
      const file = (rest ?? '').split('\n').find((line) => line.trim() !== '') ?? notePath
      items.push({
        commit,
        at,
        author: authorFromGit(name ?? '', email ?? ''),
        message: message ?? '',
        path: file,
      })
    }
    return items
  }

  /** The raw file at `commit`, only when that commit is in the note's own history. */
  async version(notePath: string, commit: string): Promise<string | null> {
    const items = await this.history(notePath)
    const match = items.find((item) => item.commit === commit || item.commit.startsWith(commit))
    if (!match) return null
    try {
      return await this.git(['show', `${match.commit}:${match.path}`])
    } catch {
      return null
    }
  }

  /** `path -> author column` for the newest commit that touched each path (bounded history walk). */
  async lastAuthors(limit = 2000): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    if (!this.available) return result
    try {
      const out = await this.git([
        'log',
        '-n',
        String(limit),
        '--name-only',
        '--no-renames',
        '--format=%x1e%an%x1f%ae%x1f',
      ])
      for (const record of out.split('\x1e')) {
        const [name, email, rest] = record.split('\x1f')
        if (!rest) continue
        const column = authorToColumn(authorFromGit(name ?? '', email ?? ''))
        for (const line of rest.split('\n'))
          if (line.trim() !== '' && !result.has(line)) result.set(line, column)
      }
    } catch {
      // empty repository
    }
    return result
  }
}
