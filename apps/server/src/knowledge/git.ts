import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { KnowledgeAuthor, KnowledgeCommit } from '@score/contract'
import { authorFromGit, authorToColumn, gitIdentity, sameAuthor } from './note.ts'

const IGNORE_BATCH = 500

const run = promisify(execFile)

/** File names from `--name-only -z` output after a format: NUL-separated, never quoted or trimmed. */
function namesOf(rest: string): string[] {
  return rest
    .replace(/^\0?\n?/, '')
    .split('\0')
    .filter((name) => name !== '')
}

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
  /** Paths the vault keeps out of git on purpose (stored-only documents). */
  private ignore: () => string[] = () => []
  private last: LastCommit | undefined

  constructor(
    private vault: string,
    private readonly now: () => number = Date.now,
  ) {}

  private async git(
    args: string[],
    options: { author?: KnowledgeAuthor; env?: Record<string, string> } = {},
  ): Promise<string> {
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
          ...options.env,
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

  setIgnore(ignore: () => string[]): void {
    this.ignore = ignore
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
    const skip = new Set(this.ignore())
    return out
      .split('\0')
      .filter((entry) => entry.length > 3)
      .map((entry) => entry.slice(3))
      .filter((entry) => !skip.has(entry))
  }

  /** True when the path differs from Git's last commit (modified, deleted or untracked); false when it cannot say. */
  async pathDirty(path: string): Promise<boolean> {
    if (!this.available) return false
    try {
      const out = await this.git(['status', '--porcelain=v1', '-z', '--no-renames', '--', path])
      return out.length > 0
    } catch {
      return false
    }
  }

  /**
   * `git add -A`, except that git refuses the whole call when a pathspec sits in an ignored folder, even for a file
   * it already tracks. Then the tracked files are staged with `-u` and the not-ignored new ones separately, so a
   * tracked note keeps its history after a rule starts matching it.
   */
  private async stage(paths: string[]): Promise<void> {
    try {
      await this.git(['add', '-A', '--', ...paths])
      return
    } catch (error) {
      try {
        await this.git(['add', '-u', '--', ...paths])
        const fresh = (
          await this.git(['ls-files', '-z', '--others', '--exclude-standard', '--', ...paths])
        )
          .split('\0')
          .filter((name) => name !== '')
        if (fresh.length > 0) await this.git(['add', '-A', '--', ...fresh])
      } catch {
        throw error
      }
    }
  }

  /**
   * Commits whatever changed outside Score as "Outside changes", so Score's own commit contains only its own
   * change. Returns true when something was committed, false when there was nothing to commit (or git is off).
   * A failure THROWS: callers about to overwrite or delete must not treat "could not snapshot" as "nothing changed".
   */
  async commitOutsideChanges(): Promise<boolean> {
    if (!this.available) return false
    const paths = await this.dirty()
    if (paths.length === 0) return false
    await this.stage(paths)
    await this.git(['commit', '-q', '--no-verify', '-m', 'Outside changes', '--', ...paths], {
      author: 'outside',
    })
    this.last = undefined
    return true
  }

  /**
   * The given paths that Git ignores and does not track. `git add` refuses those, and Score never force-adds one: the
   * note is saved but has no history. Without `--no-index`, a tracked path is never reported (it keeps its history
   * even when a rule later matches it). One argv call per path (a commit names at most a few); a failed check
   * counts as "not ignored" so the commit is tried and its own failure is reported.
   */
  async ignoredUntracked(paths: string[]): Promise<Set<string>> {
    const found = new Set<string>()
    if (!this.available) return found
    // One git run per batch of paths, not per path: a 1,000-note import took three times as long with one run each.
    // `-z` needs `--stdin`, so the output is one path per line; a path git might quote is asked about on its own.
    const plain = paths.filter((path) => !/["\\\p{Cc}]/u.test(path))
    const quoted = new Set(paths)
    for (const path of plain) quoted.delete(path)
    for (const path of quoted) if (await this.ignoredOne(path)) found.add(path)
    for (let i = 0; i < plain.length; i += IGNORE_BATCH) {
      const batch = plain.slice(i, i + IGNORE_BATCH)
      const asked = new Set(batch)
      try {
        // check-ignore refuses literal-pathspec mode, which every other call here uses. It prints the ignored ones.
        const out = await this.git(['check-ignore', '--', ...batch], {
          env: { GIT_LITERAL_PATHSPECS: '0' },
        })
        for (const path of out.split('\n')) if (asked.has(path)) found.add(path)
      } catch (error) {
        // Exit 1: none of them is ignored. Anything else: ask one by one, so one odd path can't hide the others.
        if ((error as { code?: unknown }).code === 1) continue
        for (const path of batch) if (await this.ignoredOne(path)) found.add(path)
      }
    }
    return found
  }

  private async ignoredOne(path: string): Promise<boolean> {
    try {
      await this.git(['check-ignore', '-q', '--', path], { env: { GIT_LITERAL_PATHSPECS: '0' } })
      return true // exit 0: ignored
    } catch {
      return false // exit 1: not ignored; anything else: unknown, treated the same
    }
  }

  /** Commits (or amends) the given paths. Resolves to the commit hash, or null when nothing changed or git failed. */
  async commit(options: CommitOptions): Promise<string | null> {
    if (!this.available) return null
    const { paths, message, author, amendNote } = options
    await this.stage(paths)
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
        '-z',
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
      const file = namesOf(rest ?? '')[0] ?? notePath
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

  /** Paths git tracks (HEAD's index), or null when git is off or cannot say. One call per rebuild. */
  async trackedPaths(): Promise<Set<string> | null> {
    if (!this.available) return null
    try {
      const out = await this.git(['ls-files', '-z'])
      return new Set(out.split('\0').filter((name) => name !== ''))
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
        '-z',
        '--no-renames',
        '--format=%x1e%an%x1f%ae%x1f',
      ])
      for (const record of out.split('\x1e')) {
        const [name, email, rest] = record.split('\x1f')
        if (!rest) continue
        const column = authorToColumn(authorFromGit(name ?? '', email ?? ''))
        for (const name of namesOf(rest)) if (!result.has(name)) result.set(name, column)
      }
    } catch {
      // empty repository
    }
    return result
  }
}
