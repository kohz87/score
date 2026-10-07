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
    callback: (error: ExecFileException | null) => void,
  ) => void
}
export type HermesRunner = (args: string[], options: CliOptions) => Promise<{ exitCode: number }>

export const runHermes: HermesRunner = async (args, options) => {
  const argv = z.array(z.string().refine((value) => !value.includes('\0'))).parse(args)
  const timeout = z.int().positive().parse(options.timeoutMs)
  const env: NodeJS.ProcessEnv = { HERMES_HOME: resolveHermesHome(options.hermesHome) }
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return new Promise((resolve) => {
    // Discard both output streams and the error message: they can contain task text or credentials.
    try {
      ;(options.execute ?? execFile)(
        'hermes',
        argv,
        { timeout, env, maxBuffer: 16 * 1024 },
        (error) =>
          resolve({ exitCode: error ? (typeof error.code === 'number' ? error.code : -1) : 0 }),
      )
    } catch {
      resolve({ exitCode: -1 })
    }
  })
}
