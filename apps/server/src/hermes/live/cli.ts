import { execFile, type ExecFileException, type ExecFileOptions } from 'node:child_process'
import { z } from 'zod'
import { resolveHermesHome } from './paths.ts'

export interface CliOptions {
  timeoutMs: number
  hermesHome?: string
  execute?: (
    file: string,
    args: string[],
    options: ExecFileOptions,
    callback: (error: ExecFileException | null, stdout?: string | Buffer) => void,
  ) => void
}
export type HermesRunner = (
  args: string[],
  options: CliOptions,
) => Promise<{ exitCode: number; stdout?: string }>

export const runHermes: HermesRunner = async (args, options) => {
  const argv = z.array(z.string().refine((value) => !value.includes('\0'))).parse(args)
  const timeout = z.int().positive().parse(options.timeoutMs)
  const env: NodeJS.ProcessEnv = { HERMES_HOME: resolveHermesHome(options.hermesHome) }
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return new Promise((resolve) => {
    // Never expose stderr/error messages. Successful JSON output is validated by the caller.
    try {
      ;(options.execute ?? execFile)(
        'hermes',
        argv,
        { timeout, env, maxBuffer: argv.includes('--json') ? 512 * 1024 : 16 * 1024 },
        (error, stdout) =>
          resolve({
            exitCode: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
            ...(!error && argv.includes('--json') ? { stdout: stdout?.toString() ?? '' } : {}),
          }),
      )
    } catch {
      resolve({ exitCode: -1 })
    }
  })
}
