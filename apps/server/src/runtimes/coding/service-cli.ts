import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { driverFor } from './drivers.ts'
import { helpMismatch } from './help-check.ts'
import { CodingRuntimeBase } from './service-base.ts'
import type { StoredCodingAgent } from './store.ts'

export class CodingRuntimeCli extends CodingRuntimeBase {
  /** Why this CLI may not run for this agent right now, or null. Read fresh when `fresh` (before a spawn). */
  protected async cliRefusal(
    agent: StoredCodingAgent,
    driver: ReturnType<typeof driverFor>,
    fresh: boolean,
  ): Promise<{ code: string; message: string; notice: string; cause: string } | null> {
    const cli = await this.deps.locator.detect(driver, { fresh })
    if (cli.state === 'not_supported' || cli.state === 'not_installed')
      return {
        code: 'cli_not_installed',
        message: cli.message ?? 'The CLI isn’t available.',
        notice: `${driver.label} can't run: ${cli.message ?? 'not available'}`,
        cause: 'cli_missing',
      }
    if (!this.deps.locator.verifiedPermissions(driver).includes(agent.permission))
      return {
        code: 'permission_unverified',
        message: `${driver.label} is not verified for ${agent.permission} access yet`,
        notice: `${driver.label} is not verified for ${agent.permission} access yet. Open this agent in Team and pick a verified level.`,
        cause: 'reach_unverifiable',
      }
    // 3.15.3 (decision 157): a version newer than the tested ones runs without asking unless it is broken: the help check
    // (decision 138) is what decides, the same one orchestration steps use. A runtime without one simply runs.
    if (cli.state === 'untested_version' && cli.version !== null) {
      const problem = await this.checkVersion(driver, cli.version)
      if (problem)
        return {
          code: 'untested_cli_version',
          message: problem,
          notice: `${driver.label} ${cli.version} can't run: ${problem}`,
          cause: 'version_unchecked',
        }
    }
    return null
  }

  /**
   * The help check's verdict for the agent page. Lists ask often, so a failed check is remembered for a minute instead of
   * reading the help again every time; a run always checks afresh (`cliRefusal`).
   */
  protected async versionProblemShown(
    driver: ReturnType<typeof driverFor>,
    version: string,
  ): Promise<string | null> {
    const key = `${driver.runtime}@${version}`
    const seen = this.shownProblems.get(key)
    // A run may have passed the check since a transient failure was remembered.
    if (seen && Date.now() - seen.at < 60_000 && !this.checkedVersions().has(key))
      return seen.problem
    const problem = await this.checkVersion(driver, version)
    this.shownProblems.set(key, { at: Date.now(), problem })
    return problem
  }

  /** Versions Score checked itself (3.7.7), as `runtime@version`. */
  protected checkedVersions(): Set<string> {
    const rows = this.deps.db.sqlite
      .prepare('SELECT runtime, version FROM checked_cli_versions')
      .all() as { runtime: string; version: string }[]
    return new Set(rows.map((row) => `${row.runtime}@${row.version}`))
  }

  /**
   * 3.7.7 (decision 138): a version the declaration doesn't list is checked from its help text once, and remembered when
   * every flag a worker launch relies on still reads as declared. Returns why it can't be accepted, or null.
   */
  protected async checkVersion(
    driver: ReturnType<typeof driverFor>,
    version: string,
  ): Promise<string | null> {
    const worker = driver.worker
    if (!worker || worker.versions.includes(version)) return null
    if (this.checkedVersions().has(`${driver.runtime}@${version}`)) return null
    // The version read fresh, so the help that decides belongs to the version recorded (the cached reading may be stale).
    const now = await this.deps.locator.detect(driver, { fresh: true })
    if (now.version !== version)
      return `${driver.label} changed while Score was checking it (now ${now.version ?? 'unknown'}). Try again.`
    const help = await this.deps.locator.help(driver, worker.help.args)
    if (help === null)
      return `Score couldn’t read ${driver.label} ${version}’s help to check what it reads on its own, so it can’t say what a step could reach.`
    const changed = helpMismatch(help, worker.help)
    if (changed)
      return `${driver.label} ${version} no longer describes ${changed} the way Score relies on, so Score can’t say what a step could reach. Score needs an update for this version.`
    this.deps.db.sqlite
      .prepare(
        'INSERT OR IGNORE INTO checked_cli_versions (runtime, version, checked_at) VALUES (?, ?, ?)',
      )
      .run(driver.runtime, version, new Date().toISOString())
    return null
  }

  /** The CLIs' own login files: an agent has no business reading them. */
  protected denyFiles(): string[] {
    const home = this.deps.policy.home
    return [
      join(home, '.claude', '.credentials*'),
      join(home, '.codex', 'auth*'),
      // Antigravity's sign-in and config live under ~/.gemini (no deny rules in agy itself: its sandbox is the barrier).
      join(home, '.gemini', 'antigravity-cli', '**'),
      join(home, '.gemini', '**'),
    ]
  }

  /** Folders the policy keeps off limits, in lexical and resolved form. */
  protected denyPaths(): string[] {
    return this.deps.policy.forbidden.flatMap((folder) => {
      const forms = [resolve(folder)]
      try {
        forms.push(realpathSync(folder))
      } catch {
        // not created yet: only the lexical form exists
      }
      return forms
    })
  }
}
