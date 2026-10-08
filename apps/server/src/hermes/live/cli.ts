import { execFile, type ExecFileException, type ExecFileOptions } from 'node:child_process'
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
  'skills.disabled',
  'delegation.max_concurrent_children',
  'command_allowlist',
  'approvals',
  'plugins.enabled',
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
    argv.length === 4 &&
    argv[0] === '-p' &&
    ProfileNameSchema.safeParse(argv[1]).success &&
    argv[2] === 'tools' &&
    argv[3] === 'list'
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
  if (options.captureSettings && !SETTINGS_READS.includes(argv.join(' ')))
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
  const env: NodeJS.ProcessEnv = { HERMES_HOME: resolveHermesHome(options.hermesHome) }
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return new Promise((resolve) => {
    // Only the allowlisted model read and task creation may return stdout; errors and stderr stay private.
    try {
      ;(options.execute ?? execFile)(
        'hermes',
        argv,
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
