import { homedir } from 'node:os'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { z } from 'zod'

const OriginSchema = z
  .url({ protocol: /^https?$/ })
  .refine((value) => {
    const url = new URL(value)
    return !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
  }, 'Expected an HTTP(S) origin')
  .transform((value) => new URL(value).origin)

const RemoteSchema = z.object({
  origins: z.array(OriginSchema).min(1).max(16),
  bridgePort: z.coerce.number().int().min(1).max(65535).default(8740),
  insecureHttp: z.boolean(),
  tlsCert: z.string().min(1).optional(),
  tlsKey: z.string().min(1).optional(),
})

export function isLoopback(host: string): boolean {
  const normalized = normalizeHost(host)
  const mapped = /^::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})$/i.exec(normalized)
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    (isIP(normalized) === 4 && normalized.startsWith('127.')) ||
    (mapped !== null && Number.parseInt(mapped[1]!, 16) >>> 8 === 127)
  )
}

function normalizeHost(host: string): string {
  return isIP(host) === 6 ? new URL(`http://[${host}]`).hostname.slice(1, -1) : host
}

const ConfigSchema = z.object({
  bridgeInstallUrl: z
    .url()
    .refine((value) => {
      const url = new URL(value)
      return (
        ['https:', 'file:'].includes(url.protocol) && !url.username && !url.password && !url.search
      )
    })
    .optional(),
  bridgeInstallRef: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
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
    .refine(
      (host) =>
        !host.includes('%') && (isIP(host) !== 0 || /^[a-z\d]+(?:[a-z\d.-]*[a-z\d])?$/i.test(host)),
    )
    .transform(normalizeHost)
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
  fakeLoop: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default(true),
  remote: RemoteSchema.optional(),
})

export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(env: Record<string, string | undefined>): Config {
  const remote = z.enum(['0', '1']).optional().parse(env.SCORE_REMOTE) === '1'
  const any = z.enum(['0', '1']).optional().parse(env.SCORE_REMOTE_ANY) === '1'
  const insecureHttp =
    z.literal('accept').optional().parse(env.SCORE_REMOTE_INSECURE_HTTP) === 'accept'
  const config = ConfigSchema.parse({
    bridgeInstallUrl: env.SCORE_BRIDGE_INSTALL_URL,
    bridgeInstallRef: env.SCORE_BRIDGE_INSTALL_REF,
    home: env.SCORE_HOME,
    hermesHome: env.SCORE_HERMES_HOME,
    hermesUrl: env.SCORE_HERMES_URL,
    host: env.SCORE_HOST,
    port: env.SCORE_PORT ?? (remote ? 8741 : undefined),
    webOrigin: env.SCORE_WEB_ORIGIN,
    mode: env.SCORE_MODE,
    fakeSpeed: env.SCORE_FAKE_SPEED,
    fakeLoop: env.SCORE_FAKE_LOOP,
    ...(remote
      ? {
          remote: {
            origins: env.SCORE_PUBLIC_ORIGINS?.split(',').map((origin) => origin.trim()) ?? [],
            bridgePort: env.SCORE_BRIDGE_PORT,
            insecureHttp,
            tlsCert: env.SCORE_TLS_CERT,
            tlsKey: env.SCORE_TLS_KEY,
          },
        }
      : {}),
  })
  const fail = (message: string): never => {
    throw new z.ZodError([{ code: 'custom', path: [], message }])
  }
  if (!remote && !isLoopback(config.host)) fail('Non-loopback SCORE_HOST requires SCORE_REMOTE=1')
  if (remote && isIP(config.host) === 0) fail('Remote SCORE_HOST must be a numeric IP address')
  if (remote && ['0.0.0.0', '::', '::ffff:0:0'].includes(config.host) && !any)
    fail('Wildcard SCORE_HOST requires SCORE_REMOTE_ANY=1')
  if (
    !remote &&
    (any ||
      insecureHttp ||
      env.SCORE_TLS_CERT !== undefined ||
      env.SCORE_TLS_KEY !== undefined ||
      env.SCORE_PUBLIC_ORIGINS !== undefined ||
      env.SCORE_BRIDGE_PORT !== undefined)
  )
    fail('Remote options require SCORE_REMOTE=1')
  if (config.remote) {
    const options = config.remote
    if (Boolean(options.tlsCert) !== Boolean(options.tlsKey))
      fail('SCORE_TLS_CERT and SCORE_TLS_KEY must be set together')
    const tls = Boolean(options.tlsCert)
    if (!tls && !insecureHttp)
      fail(
        'Remote HTTP requires SCORE_REMOTE_INSECURE_HTTP=accept; use SCORE_TLS_CERT and SCORE_TLS_KEY for TLS',
      )
    if (tls && insecureHttp) fail('Do not combine TLS with SCORE_REMOTE_INSECURE_HTTP')
    if (options.origins.some((origin) => new URL(origin).protocol !== (tls ? 'https:' : 'http:')))
      fail('SCORE_PUBLIC_ORIGINS must match the listener transport')
    if (config.port === options.bridgePort)
      fail('Browser SCORE_PORT and SCORE_BRIDGE_PORT must differ')
  }
  return config
}

export function serverOrigin(config: Config): string {
  if (config.remote) return config.remote.origins[0]!
  const host = isIP(config.host) === 6 ? `[${config.host}]` : config.host
  return new URL(`http://${host}:${config.port}`).origin
}
