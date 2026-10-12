import { homedir } from 'node:os'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { z } from 'zod'
import { journalInsideHome } from './journal-location.ts'

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
  tlsCert: z.string().min(1).optional(),
  tlsKey: z.string().min(1).optional(),
  // Extra certificates by server name (`<name>.crt` + `<name>.key`), e.g. from `tailscale cert` (5.22).
  tlsNamesDir: z.string().min(1).optional(),
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
  // The orchestration execution journal (SCORE_JOURNAL_DIR); see resolveJournalDir.
  journalDir: z.string().min(1).optional(),
  // The knowledge vault (SCORE_VAULT); default ~/score-vault, or a temporary folder in fake mode (start-server).
  vault: z.string().min(1).optional(),
  // Media store quota in MiB (default 512, applied by the store).
  mediaQuotaMb: z.coerce.number().int().min(1).optional(),
  fakeSpeed: z.coerce.number().positive().default(1),
  fakeLoop: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default(true),
  // Serve the built web app from this server (production); Vite does it in development.
  // The launcher's log file (SCORE_LOG_FILE), for the log viewer; absent in dev and tests.
  logFile: z.string().min(1).optional(),
  serveWeb: z.boolean().default(false),
  // The web terminal (PLAN 7.3): a shell on this machine for paired browsers. Off unless SCORE_TERMINAL=1; the routes
  // are not registered otherwise.
  terminal: z.boolean().default(false),
  // SCORE_REMOTE_INSECURE_HTTP was removed (5.18): it is ignored, and the server says so at startup.
  ignoredInsecureHttp: z.boolean().default(false),
  remote: RemoteSchema.optional(),
})

export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(env: Record<string, string | undefined>): Config {
  const remote = z.enum(['0', '1']).optional().parse(env.SCORE_REMOTE) === '1'
  if (remote && !env.SCORE_PUBLIC_ORIGINS?.trim())
    throw new Error(
      'Remote mode needs SCORE_PUBLIC_ORIGINS: the address browsers use, e.g. https://score.example.ts.net:8741',
    )
  const any = z.enum(['0', '1']).optional().parse(env.SCORE_REMOTE_ANY) === '1'
  const config = ConfigSchema.parse({
    bridgeInstallUrl: env.SCORE_BRIDGE_INSTALL_URL,
    bridgeInstallRef: env.SCORE_BRIDGE_INSTALL_REF,
    home: env.SCORE_HOME,
    hermesHome: env.SCORE_HERMES_HOME,
    hermesUrl: env.SCORE_HERMES_URL,
    host: env.SCORE_HOST,
    port: env.SCORE_PORT ?? (remote ? 8741 : undefined),
    // Changing only the dev web port must not break pairing: the origin follows SCORE_WEB_PORT unless set explicitly.
    webOrigin:
      env.SCORE_WEB_ORIGIN ??
      (env.SCORE_WEB_PORT ? `http://127.0.0.1:${env.SCORE_WEB_PORT}` : undefined),
    mode: env.SCORE_MODE,
    journalDir: env.SCORE_JOURNAL_DIR,
    logFile: env.SCORE_LOG_FILE || undefined,
    vault: env.SCORE_VAULT,
    mediaQuotaMb: env.SCORE_MEDIA_QUOTA_MB,
    fakeSpeed: env.SCORE_FAKE_SPEED,
    fakeLoop: env.SCORE_FAKE_LOOP,
    ignoredInsecureHttp: env.SCORE_REMOTE_INSECURE_HTTP !== undefined,
    terminal: z.enum(['0', '1']).optional().parse(env.SCORE_TERMINAL) === '1',
    serveWeb:
      z.enum(['0', '1']).optional().parse(env.SCORE_SERVE_WEB) === '1' ||
      env.NODE_ENV === 'production',
    ...(remote
      ? {
          remote: {
            origins: env.SCORE_PUBLIC_ORIGINS?.split(',').map((origin) => origin.trim()) ?? [],
            bridgePort: env.SCORE_BRIDGE_PORT,
            tlsCert: env.SCORE_TLS_CERT,
            tlsKey: env.SCORE_TLS_KEY,
            tlsNamesDir: env.SCORE_TLS_NAMES_DIR,
          },
        }
      : {}),
  })
  const fail = (message: string): never => {
    throw new z.ZodError([{ code: 'custom', path: [], message }])
  }
  if (config.mode !== 'fake') {
    const inside = journalInsideHome(resolveJournalDir(config, env), config.home)
    if (inside) fail(inside)
  }
  if (!remote && !isLoopback(config.host)) fail('Non-loopback SCORE_HOST requires SCORE_REMOTE=1')
  if (remote && isIP(config.host) === 0) fail('Remote SCORE_HOST must be a numeric IP address')
  if (remote && ['0.0.0.0', '::', '::ffff:0:0'].includes(config.host) && !any)
    fail('Wildcard SCORE_HOST requires SCORE_REMOTE_ANY=1')
  if (
    !remote &&
    (any ||
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
    if (options.tlsNamesDir && !options.tlsCert)
      fail('SCORE_TLS_NAMES_DIR needs a default certificate (SCORE_TLS_CERT and SCORE_TLS_KEY)')
    // Without a certificate Score runs in guide-only mode (see guideOnly): the origins are never used to serve the app.
    if (options.tlsCert && options.origins.some((origin) => new URL(origin).protocol !== 'https:'))
      fail('SCORE_PUBLIC_ORIGINS must be https:// addresses')
    if (config.port === options.bridgePort)
      fail('Browser SCORE_PORT and SCORE_BRIDGE_PORT must differ')
  }
  return config
}

/** Remote mode without a certificate: the server only shows the HTTPS setup guide (nothing else is served). */
export function guideOnly(config: Pick<Config, 'remote'>): boolean {
  return config.remote !== undefined && !config.remote.tlsCert
}

export function serverOrigin(config: Config): string {
  if (config.remote) return config.remote.origins[0]!
  const host = isIP(config.host) === 6 ? `[${config.host}]` : config.host
  return new URL(`http://${host}:${config.port}`).origin
}

/**
 * Where the orchestration execution journal lives (design 7.5 v3): outside $SCORE_HOME, so restoring the home cannot
 * rewind it. Live: `$SCORE_JOURNAL_DIR`, else `$XDG_STATE_HOME/score/execution-journal`, else
 * `~/.local/state/score/execution-journal`. The fake adapter starts no real runs, so its journal stays in the home.
 */
export function resolveJournalDir(
  config: Pick<Config, 'mode' | 'home' | 'journalDir'>,
  env: Record<string, string | undefined> = process.env,
): string {
  if (config.journalDir) return config.journalDir
  if (config.mode === 'fake') return join(config.home, 'execution-journal')
  return join(
    env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
    'score',
    'execution-journal',
  )
}
