import { execFile, type ExecFileException, type ExecFileOptions } from 'node:child_process'
import { z } from 'zod'
import { ProfileNameSchema, resolveHermesHome } from './paths.ts'

export interface CliOptions {
  timeoutMs: number
  hermesHome?: string
  captureModel?: boolean
  // `kanban create --json …`: the only write whose output is read (the new task id).
  captureTaskCreate?: boolean
  // Settings status reads (`auth list`, `config get --json mcp_servers|providers`): Hermes prints no secrets for
  // these, and callers parse only the fields they need.
  captureSettings?: boolean
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
  if (options.captureSettings && !SETTINGS_READS.includes(argv.join(' ')))
    throw new Error('CLI stdout capture is restricted to settings status reads')
  const capture = options.captureModel || options.captureTaskCreate || options.captureSettings
  // The create echo includes the task body; the model value is tiny.
  const captureLimit = options.captureTaskCreate
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
