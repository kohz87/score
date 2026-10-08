import { homedir } from 'node:os'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { z } from 'zod'

const ConfigSchema = z.object({
  home: z.string().min(1).default(join(homedir(), '.score')),
  // Default (the user's Hermes home) is resolved inside the Hermes adapter.
  hermesHome: z.string().min(1).optional(),
  hermesUrl: z
    .url({ protocol: /^https?$/ })
    .pipe(
      z.string().refine((value) => {
        const url = new URL(value)
        return !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
      }, 'Expected an HTTP(S) origin'),
    )
    .optional(),
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
  // Media store quota in MiB (default 512, applied by the store).
  mediaQuotaMb: z.coerce.number().int().min(1).optional(),
  fakeSpeed: z.coerce.number().positive().default(1),
  fakeLoop: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default(true),
})

export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(env: Record<string, string | undefined>): Config {
  return ConfigSchema.parse({
    home: env.SCORE_HOME,
    hermesHome: env.SCORE_HERMES_HOME,
    hermesUrl: env.SCORE_HERMES_URL,
    host: env.SCORE_HOST,
    port: env.SCORE_PORT,
    webOrigin: env.SCORE_WEB_ORIGIN,
    mode: env.SCORE_MODE,
    mediaQuotaMb: env.SCORE_MEDIA_QUOTA_MB,
    fakeSpeed: env.SCORE_FAKE_SPEED,
    fakeLoop: env.SCORE_FAKE_LOOP,
  })
}

export function serverOrigin(config: Config): string {
  const host = isIP(config.host) === 6 ? `[${config.host}]` : config.host
  return new URL(`http://${host}:${config.port}`).origin
}
