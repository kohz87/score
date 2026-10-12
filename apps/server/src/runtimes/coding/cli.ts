import { execFile } from 'node:child_process'
import type { CliState, CodingPermission, CodingRuntimeInfo } from '@score/contract'
import { DRIVERS, isTestedVersion } from './drivers.ts'
import { buildChildEnv } from './env.ts'
import { resolveNativeExecutable, resolveOnPath } from './native-exec.ts'
import type { CodingDriver } from './types.ts'

export interface CliLocatorOptions {
  /** Test/fake mode only: a Node script that stands in for every CLI (`node <script> <runtime> <args…>`). */
  fakeCli?: string
  env?: NodeJS.ProcessEnv
  /** How long a version reading is reused. */
  cacheMs?: number
  clock?: () => number
  /** Fake mode without a fake CLI: no CLI is ever started; every one reports this reason. */
  disabled?: string
}

export interface DetectedCli {
  state: CliState
  version: string | null
  message: string | null
}

/** Finds the CLIs and reads their versions (`--version` only: nothing here ever sends a prompt). */
export class CliLocator {
  readonly fake: boolean
  private readonly cache = new Map<string, { at: number; value: DetectedCli }>()
  private readonly options: Required<Pick<CliLocatorOptions, 'cacheMs'>> & CliLocatorOptions

  constructor(options: CliLocatorOptions = {}) {
    this.options = { cacheMs: 60_000, ...options }
    this.fake = Boolean(options.fakeCli)
  }

  /** The executable and leading arguments for a driver. */
  command(driver: CodingDriver): { file: string; args: string[] } {
    if (this.options.disabled) throw new Error(this.options.disabled)
    return this.options.fakeCli
      ? { file: process.execPath, args: [this.options.fakeCli, driver.runtime] }
      : { file: driver.executable, args: [] }
  }

  /**
   * `command()` for the fallback launch: the CLI's real native executable, or a refusal message. Fake mode runs its
   * Node stand-in as is. A launcher that spawns the engine could not be stopped when Score dies.
   */
  nativeCommand(
    driver: CodingDriver,
  ): { ok: true; file: string; args: string[] } | { ok: false; message: string } {
    const command = this.command(driver)
    if (this.fake) return { ok: true, ...command }
    const resolved = resolveNativeExecutable(
      driver.runtime,
      driver.label,
      command.file,
      (this.options.env ?? process.env).PATH,
    )
    return resolved.ok ? { ok: true, file: resolved.file, args: command.args } : resolved
  }

  childEnv(): Record<string, string> {
    return buildChildEnv(this.options.env ?? process.env, { fake: this.fake })
  }

  /**
   * The levels offered for a driver. The driver lists what has been live-verified; the owner's environment can widen it
   * (`SCORE_CODING_VERIFIED_ANTIGRAVITY=read-only,workspace-write`) while a level is being verified, and in fake mode
   * with a fake CLI nothing real can run, so tests and e2e use the override too.
   */
  verifiedPermissions(driver: CodingDriver): CodingPermission[] {
    const raw = (this.options.env ?? process.env)[
      `SCORE_CODING_VERIFIED_${driver.runtime.replace(/-/g, '_').toUpperCase()}`
    ]
    if (raw === undefined) return [...driver.verifiedPermissions]
    const wanted = new Set(raw.split(',').map((item) => item.trim()))
    return (['read-only', 'workspace-write', 'full'] as const).filter((level) => wanted.has(level))
  }

  invalidate(): void {
    this.cache.clear()
  }

  /** `fresh` skips the cache: used right before a spawn, where a stale reading must not decide. */
  async detect(driver: CodingDriver, { fresh = false } = {}): Promise<DetectedCli> {
    const now = (this.options.clock ?? Date.now)()
    const hit = this.cache.get(driver.runtime)
    if (!fresh && hit && now - hit.at < this.options.cacheMs) return hit.value
    const value = await this.read(driver)
    this.cache.set(driver.runtime, { at: now, value })
    return value
  }

  private read(driver: CodingDriver): Promise<DetectedCli> {
    if (!driver.supported)
      return Promise.resolve({
        state: 'not_supported',
        version: null,
        message: `${driver.label} is not supported by this version of Score yet.`,
      })
    if (this.options.disabled)
      return Promise.resolve({
        state: 'not_installed',
        version: null,
        message: this.options.disabled,
      })
    const command = this.command(driver)
    // The same absolute-PATH search the fallback uses, so the file that reports a version is the file that would run.
    const file = this.fake
      ? command.file
      : resolveOnPath(command.file, (this.options.env ?? process.env).PATH)
    const { args } = command
    if (file === null)
      return Promise.resolve({
        state: 'not_installed',
        version: null,
        message: `${driver.label} (${driver.executable}) is not installed or not on PATH.`,
      })
    return new Promise((resolve) => {
      execFile(
        file,
        [...args, '--version'],
        { env: this.childEnv(), timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true },
        (error, stdout) => {
          if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT')
            return resolve({
              state: 'not_installed',
              version: null,
              message: `${driver.label} (${driver.executable}) is not installed or not on PATH.`,
            })
          const version = driver.parseVersion(stdout)
          if (error || !version)
            return resolve({
              state: 'not_installed',
              version: null,
              message: `${driver.label} did not report a version (${driver.executable} --version).`,
            })
          resolve(
            isTestedVersion(driver, version)
              ? { state: 'ready', version, message: null }
              : {
                  state: 'untested_version',
                  version,
                  message: `${driver.label} ${version} is not one of the tested versions (${driver.testedVersions.join(', ')}). Confirm it to run anyway.`,
                },
          )
        },
      )
    })
  }

  async info(): Promise<CodingRuntimeInfo[]> {
    return Promise.all(
      Object.values(DRIVERS).map(async (driver) => {
        const detected = await this.detect(driver)
        return {
          runtime: driver.runtime,
          label: driver.label,
          state: detected.state,
          version: detected.version,
          testedVersions: [...driver.testedVersions],
          quota: driver.quota,
          message: detected.message,
          unverifiedPermissions: (['read-only', 'workspace-write', 'full'] as const).filter(
            (level) => !this.verifiedPermissions(driver).includes(level),
          ),
          warning: driver.warning,
        }
      }),
    )
  }
}

/**
 * The locator for a server mode. Fake mode never executes a real CLI, whatever the environment says: it uses the
 * fake script when `SCORE_CODING_FAKE_CLI` names one, and otherwise coding agents are unavailable. Under test the
 * override is honoured in any mode; a live server ignores it.
 */
export function locatorForMode(mode: 'live' | 'fake', env: NodeJS.ProcessEnv): CliLocator {
  const fakeCli = env.SCORE_CODING_FAKE_CLI
  if (fakeCli && (mode === 'fake' || env.NODE_ENV === 'test')) return new CliLocator({ fakeCli })
  if (mode === 'fake')
    return new CliLocator({
      disabled: 'Coding agents need a real CLI, which fake mode never starts.',
    })
  return new CliLocator()
}
