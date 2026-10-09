import { basename, dirname } from 'node:path'
import { execFile, spawn, type ExecFileException, type ExecFileOptions } from 'node:child_process'
import { z } from 'zod'
import { isExcludedConfigKey } from '../config-keys.ts'
import { ProfileNameSchema, resolveHermesHome } from './paths.ts'

export interface CliOptions {
  timeoutMs: number
  hermesHome?: string
  captureModel?: boolean
  // `kanban create --json …`: the only write whose output is read (the new task id).
  captureTaskCreate?: boolean
  // Allowlisted read-only commands (see captureReadShape): config values, tool list, hub search.
  captureRead?: boolean
  /** Bypass the config-read cache (mutation baselines and verification reads must see the file as it is now). */
  fresh?: boolean
  // Settings status reads (`auth list`, `config get --json mcp_servers|providers`): Hermes prints no secrets for
  // these, and callers parse only the fields they need.
  captureSettings?: boolean
  /** These values reach execFile only; the runner never returns stdout or exception argv for them. */
  sensitiveArgIndices?: number[]
  execute?: (
    file: string,
    args: string[],
    options: ExecFileOptions,
    callback: (
      error: ExecFileException | null,
      stdout?: string | Buffer,
      stderr?: string | Buffer,
    ) => void,
  ) => void
}
export type HermesRunner = (
  args: string[],
  options: CliOptions,
) => Promise<{ exitCode: number; stdout?: string }>

const ReadConfigKeys = [
  'model',
  'providers',
  'skills.disabled',
  'delegation.max_concurrent_children',
  'command_allowlist',
  'approvals',
  'plugins.enabled',
  // Team › agent › Workspace: where the agent's terminal works, and whether that is this machine.
  'terminal.cwd',
  'terminal.backend',
  // Team › agent › Model: fallback chain, aliases and speech models (5.31). Read into memory, never logged.
  'fallback_providers',
  'fallback_model', // the legacy key Hermes still appends to the chain
  'model_aliases',
  'tts',
  'stt',
]
/** Exact argv shapes whose stdout Score may read. Everything else keeps its output private. */
export function captureReadShape(argv: string[]): boolean {
  // Advanced config reads one top-level section; a credential-shaped or env-backed name is never read.
  if (
    argv.length === 4 &&
    argv[0] === 'config' &&
    argv[1] === 'get' &&
    argv[2] === '--json' &&
    /^[a-z][a-z0-9_-]{0,63}$/.test(argv[3]!)
  )
    return !isExcludedConfigKey(argv[3]!)
  if (argv.length === 6 && argv[0] === '-p' && ProfileNameSchema.safeParse(argv[1]).success) {
    const rest = argv.slice(2, 5).join(' ')
    if (rest === 'config get --json' && ReadConfigKeys.includes(argv[5]!)) return true
  }
  if (
    argv.length === 6 &&
    argv[0] === '-p' &&
    ProfileNameSchema.safeParse(argv[1]).success &&
    argv.slice(2, 5).join(' ') === 'tools list --platform' &&
    argv[5] === 'api_server'
  )
    return true
  // Plugin list for one profile (Team › agent › Plugins).
  if (
    argv.length === 5 &&
    argv[0] === '-p' &&
    ProfileNameSchema.safeParse(argv[1]).success &&
    argv.slice(2).join(' ') === 'plugins list --json'
  )
    return true
  return (
    argv.length === 7 &&
    argv.slice(0, 3).join(' ') === 'skills search --json' &&
    argv[3] === '--limit' &&
    /^\d{1,3}$/.test(argv[4]!) &&
    argv[5] === '--' &&
    argv[6]!.length > 0 &&
    argv[6]!.length <= 200
  )
}
const SETTINGS_READS = ['auth list', 'config get --json mcp_servers', 'config get --json providers']
/** The settings reads, optionally scoped to one profile with a leading `-p <name>`. */
function settingsRead(argv: string[]): boolean {
  const scoped = argv[0] === '-p' && ProfileNameSchema.safeParse(argv[1]).success
  return SETTINGS_READS.includes((scoped ? argv.slice(2) : argv).join(' '))
}
function hermesEnv(hermesHome: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HERMES_HOME: resolveHermesHome(hermesHome) }
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return env
}

// Provider sign-in (ARCHITECTURE D2.7): the only long-running or stdin-fed Hermes commands. Exact shapes only,
// with an optional leading `-p <profile>`; the provider id and label are validated here as well as by callers.
const SignInProviderSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
const SignInLabelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/)
export type SignInShape = 'device_code' | 'api_key'
export function signInShape(argv: string[]): SignInShape | null {
  const rest =
    argv[0] === '-p' && ProfileNameSchema.safeParse(argv[1]).success ? argv.slice(2) : argv
  if (rest[0] !== 'auth' || rest[1] !== 'add' || !SignInProviderSchema.safeParse(rest[2]).success)
    return null
  if (
    rest.length === 6 &&
    rest[3] === '--type' &&
    rest[4] === 'oauth' &&
    rest[5] === '--no-browser'
  )
    return 'device_code'
  if (
    rest.length === 7 &&
    rest[3] === '--type' &&
    rest[4] === 'api-key' &&
    rest[5] === '--label' &&
    SignInLabelSchema.safeParse(rest[6]).success
  )
    return 'api_key'
  return null
}

export interface HermesChild {
  /** Kills the whole process group by the handle's pid; never by name or pattern. */
  kill(): void
  /** Exit code; -1 when it could not start or died from a signal. */
  readonly exited: Promise<number>
}
export interface SpawnOptions {
  hermesHome?: string | undefined
  /** Written to stdin (then closed). Without it stdin is closed immediately. Never logged or captured. */
  input?: string
  /** Receives stdout text; without it stdout is discarded. stderr is always discarded. */
  onStdout?: (chunk: string) => void
}
export type HermesSpawner = (argv: string[], options: SpawnOptions) => HermesChild

export const spawnHermes: HermesSpawner = (args, options) => {
  const argv = z.array(z.string().refine((value) => !value.includes('\0'))).parse(args)
  const shape = signInShape(argv)
  if (!shape) throw new Error('Spawning is restricted to provider sign-in commands')
  if ((shape === 'api_key') !== (options.input !== undefined))
    throw new Error('Only the API key sign-in takes stdin')
  // detached = new session: no controlling terminal, so a password prompt reads stdin instead of /dev/tty.
  const child = spawn('hermes', pinScope(argv, options.hermesHome), {
    detached: true,
    env: hermesEnv(options.hermesHome),
    stdio: ['pipe', options.onStdout ? 'pipe' : 'ignore', 'ignore'],
  })
  const exited = new Promise<number>((resolve) => {
    child.once('error', () => resolve(-1))
    child.once('close', (code) => resolve(code ?? -1))
  })
  child.stdin?.on('error', () => undefined)
  child.stdin?.end(options.input)
  if (options.onStdout) {
    const onStdout = options.onStdout
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => onStdout(chunk))
  }
  let finished = false
  void exited.then(() => {
    finished = true
  })
  return {
    exited,
    kill() {
      if (finished || child.pid === undefined) return
      const signal = (name: NodeJS.Signals) => {
        try {
          process.kill(-child.pid!, name)
        } catch {
          // Already gone.
        }
      }
      signal('SIGTERM')
      setTimeout(() => {
        if (!finished) signal('SIGKILL')
      }, 2000).unref()
    },
  }
}

/**
 * Hermes picks the profile from its sticky `active_profile` file and the Kanban board from its persisted
 * "current" pointer when a command names neither (hermes_cli/main.py `_apply_profile_override`, kanban_db
 * `get_current_board`). Score's unscoped commands mean the default profile and the default board (the one
 * its read-only database reads see), so both are spelled out here, after the allowlists have matched.
 */
export function pinScope(argv: string[], hermesHome: string | undefined): string[] {
  let out = argv
  const first = out[0]
  // A home that already is a profile directory pins the profile on its own.
  const homeIsProfile = basename(dirname(resolveHermesHome(hermesHome))) === 'profiles'
  if (!homeIsProfile && first !== undefined && !first.startsWith('-') && first !== 'profile')
    out = ['-p', 'default', ...out]
  const at = out[0] === '-p' ? 2 : 0
  if (out[at] === 'kanban' && out[at + 1] !== '--board')
    out = [...out.slice(0, at + 1), '--board', 'default', ...out.slice(at + 1)]
  return out
}

export const runHermes: HermesRunner = async (args, options) => {
  const argv = z.array(z.string().refine((value) => !value.includes('\0'))).parse(args)
  if (
    options.captureModel &&
    !(
      argv.length === 6 &&
      argv[0] === '-p' &&
      ProfileNameSchema.safeParse(argv[1]).success &&
      argv.slice(2).join(' ') === 'config get --json model'
    )
  ) {
    throw new Error('CLI stdout capture is restricted to model reads')
  }
  if (options.captureTaskCreate && argv.slice(0, 3).join(' ') !== 'kanban create --json')
    throw new Error('CLI stdout capture is restricted to task creation')
  if (options.captureRead && !captureReadShape(argv))
    throw new Error('CLI stdout capture is restricted to allowlisted reads')
  if (options.captureSettings && !settingsRead(argv))
    throw new Error('CLI stdout capture is restricted to settings status reads')
  const capture =
    options.captureModel ||
    options.captureTaskCreate ||
    options.captureRead ||
    options.captureSettings
  if ((options.sensitiveArgIndices?.length || argv.includes('API_SERVER_KEY')) && capture)
    throw new Error('Sensitive CLI arguments cannot be captured')
  // The create echo includes the task body and reads can list many tools; the model value is tiny.
  const captureLimit =
    options.captureTaskCreate || options.captureRead
      ? 512 * 1024
      : options.captureSettings
        ? 256 * 1024
        : 16 * 1024
  const timeout = z.int().positive().parse(options.timeoutMs)
  const env = hermesEnv(options.hermesHome)
  return new Promise((resolve) => {
    // Only the allowlisted model read and task creation may return stdout; errors and stderr stay private.
    try {
      ;(options.execute ?? execFile)(
        'hermes',
        pinScope(argv, options.hermesHome),
        { timeout, env, maxBuffer: captureLimit },
        (error, stdout) => {
          const exitCode = error ? (typeof error.code === 'number' ? error.code : -1) : 0
          const output = stdout?.toString() ?? ''
          resolve({
            exitCode,
            ...(capture && exitCode === 0 && Buffer.byteLength(output) <= captureLimit
              ? { stdout: output }
              : {}),
          })
        },
      )
    } catch {
      resolve({ exitCode: -1 })
    }
  })
}
