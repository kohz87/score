import { execFile, type ExecFileException, type ExecFileOptions } from 'node:child_process'
import { z } from 'zod'
import { ProfileNameSchema, resolveHermesHome } from './paths.ts'

export interface CliOptions {
  timeoutMs: number
  hermesHome?: string
  captureModel?: boolean
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
  const timeout = z.int().positive().parse(options.timeoutMs)
  const env: NodeJS.ProcessEnv = { HERMES_HOME: resolveHermesHome(options.hermesHome) }
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return new Promise((resolve) => {
    // Only the allowlisted model read may return stdout; errors and stderr stay private.
    try {
      ;(options.execute ?? execFile)(
        'hermes',
        argv,
        { timeout, env, maxBuffer: 16 * 1024 },
        (error, stdout) => {
          const exitCode = error ? (typeof error.code === 'number' ? error.code : -1) : 0
          const output = stdout?.toString() ?? ''
          resolve({
            exitCode,
            ...(options.captureModel && exitCode === 0 && Buffer.byteLength(output) <= 16 * 1024
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
