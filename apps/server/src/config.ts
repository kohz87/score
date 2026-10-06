import { homedir } from 'node:os'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { z } from 'zod'

const ConfigSchema = z.object({
  home: z.string().min(1).default(join(homedir(), '.score')),
  host: z
    .string()
    .refine((host) => isIP(host) !== 0 || /^[a-z\d]+(?:[a-z\d.-]*[a-z\d])?$/i.test(host))
    .default('127.0.0.1'),
  port: z.coerce.number().int().min(1).max(65535).default(8740),
  webOrigin: z
    .url({ protocol: /^https?$/ })
    .pipe(
      z.string().refine((value) => {
        const url = new URL(value)
        return !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
      }, 'Expected an HTTP(S) origin'),
    )
    .transform((value) => new URL(value).origin)
    .default('http://127.0.0.1:5173'),
  mode: z.enum(['fake', 'live']).default('fake'),
  fakeSpeed: z.coerce.number().positive().default(1),
})

export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(env: Record<string, string | undefined>): Config {
  return ConfigSchema.parse({
    home: env.SCORE_HOME,
    host: env.SCORE_HOST,
    port: env.SCORE_PORT,
    webOrigin: env.SCORE_WEB_ORIGIN,
    mode: env.SCORE_MODE,
    fakeSpeed: env.SCORE_FAKE_SPEED,
  })
}

export function serverOrigin(config: Config): string {
  const host = isIP(config.host) === 6 ? `[${config.host}]` : config.host
  return new URL(`http://${host}:${config.port}`).origin
}
