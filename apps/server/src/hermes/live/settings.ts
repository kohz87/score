import fs from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type {
  ConnectResult,
  ProviderKeyRequest,
  SignIn,
  ConnectionsResponse,
  LocalProviderRequest,
  ToolServerRequest,
} from '@score/contract'
import { HttpError } from '../../errors.ts'
import { messagingFields } from '../messaging-fields.ts'
import { redact, redactBounded } from '../../redact.ts'
import {
  runHermes,
  spawnHermes,
  type HermesChild,
  type HermesRunner,
  type HermesSpawner,
} from './cli.ts'
import { SignInManager } from './sign-in.ts'
import { ProfileLocks } from './profile-locks.ts'
import { resolveHermesHome } from './paths.ts'
import type { ProviderBase } from '../port.ts'

// Provider and connection status comes from Hermes itself: `hermes auth list` (labels and counts, never key
// material), `hermes config get --json …` (Hermes masks secret-shaped values) and the gateway's runtime
// status file. Score never opens .env, auth.json or any credential store.
const MAX_STATE_BYTES = 1024 * 1024
// The first reads after a start run several cold Python processes at once; 8 s timed out (2026-10-08 live).
const READ_TIMEOUT_MS = 20_000
const ProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)

// Providers worth showing even when Hermes has no credential for them yet.
const CATALOG: Record<string, string> = {
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  'openai-codex': 'ChatGPT (Codex)',
  nous: 'Nous Portal',
}
// Browser sign-in kind per provider (ARCHITECTURE D2.7). Device-code providers are the ones whose
// `hermes auth add <id> --type oauth --no-browser` prints a verification link and a user code and then polls:
// hermes_cli/auth_commands.py `_OAUTH_ADD_SPECS` + `_add_nous_oauth_credential`, with the printing in
// auth_codex.py `_codex_device_code_login` (the default Codex flow), auth_nous.py `_nous_device_code_login`,
// auth_xai.py `_xai_oauth_device_code_login` and auth_minimax.py `_minimax_oauth_login`
// (via auth_device_flow.py `_print_device_code_instructions`). Not device-code: `anthropic` (PKCE, needs a localhost
// callback), `openrouter` (PKCE), `qwen-oauth` (borrows the Qwen CLI's login); they stay "terminal" unless the
// provider also takes a pasted key (gateway `auth_type: "api_key"`).
const DEVICE_CODE_PROVIDERS = new Set(['openai-codex', 'nous', 'xai-oauth', 'minimax-oauth'])
// Used when the gateway can't be read: the short built-in list's key providers.
const FALLBACK_KEY_PROVIDERS = new Set(['openrouter', 'anthropic'])
type SignInKind = NonNullable<ProviderBase['signIn']>
// Hermes 0.21.5 reports no auth_type for anthropic, but `auth add anthropic --type api-key` takes a console key
// (auth_commands.py `_add_credential` → `_add_api_key_credential` for any provider); its subscription login stays PKCE.
const ALSO_KEY_PROVIDERS = new Set(['anthropic'])
export function signInKind(id: string, authType: string | undefined): SignInKind {
  if (DEVICE_CODE_PROVIDERS.has(id)) return 'device_code'
  return authType === 'api_key' || ALSO_KEY_PROVIDERS.has(id) ? 'api_key' : 'terminal'
}
const KEY_TIMEOUT_MS = 30_000

// Messaging platforms of the tested Hermes (0.21.5 hermes_cli/platforms.py PLATFORMS, minus cli, api_server and cron,
// which aren't places to reach an agent). Plugin-registered platforms still appear when gateway_state.json reports them.
const PLATFORMS: Record<string, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  whatsapp_cloud: 'WhatsApp Business (Cloud)',
  signal: 'Signal',
  bluebubbles: 'BlueBubbles',
  email: 'Email',
  mattermost: 'Mattermost',
  matrix: 'Matrix',
  dingtalk: 'DingTalk',
  feishu: 'Feishu',
  wecom: 'WeCom',
  wecom_callback: 'WeCom Callback',
  weixin: 'Weixin',
  qqbot: 'QQBot',
  yuanbao: 'Yuanbao',
  webhook: 'Webhook',
}
const HEADER = /^([a-z0-9][a-z0-9._-]{0,63}) \((\d+) credentials?\):\s*$/
const FREE_TIER = /^([a-z0-9][a-z0-9._-]{0,63}): (.{1,120})$/
const ROW = /^\s+#\d+\s+.+?\s+(oauth|api_key)\s+id=\S+\s+priority=-?\d+(.*)$/
const StateSchema = z.object({
  platforms: z
    .record(
      z.string(),
      z
        .object({
          state: z.string().optional(),
          error_code: z.union([z.string(), z.number()]).nullish(),
          error_message: z.string().nullish(),
        })
        .passthrough(),
    )
    .optional(),
})
const ServersSchema = z.record(z.string(), z.unknown())
const LocalProvidersSchema = z.record(
  z.string(),
  z.object({ name: z.string().optional(), base_url: z.string().optional() }).passthrough(),
)

export function providerLabel(id: string, name?: string): string {
  return CATALOG[id] ?? name ?? title(id)
}
function title(id: string): string {
  return id.replace(/[-_.]+/g, ' ').replace(/^./, (c) => c.toUpperCase())
}
function quote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'custom endpoint'
  }
}

type GatewayPlatforms = NonNullable<z.infer<typeof StateSchema>['platforms']>

/** The gateway's runtime status file in one Hermes home; unreadable or oversized files read as empty. */
export function readGatewayPlatforms(home: string): GatewayPlatforms {
  try {
    const path = join(home, 'gateway_state.json')
    if (fs.statSync(path).size > MAX_STATE_BYTES) return {}
    return StateSchema.parse(JSON.parse(fs.readFileSync(path, 'utf8'))).platforms ?? {}
  } catch {
    return {}
  }
}

/**
 * One profile's platforms. A multiplexing gateway records every served profile in the host's file as
 * "<profile>:<platform>" and its own adapters as flat keys; a standalone gateway writes flat keys into the
 * profile's own file (hermes gateway/status.py `profile_platforms_from_multiplexer`).
 */
export function readProfilePlatforms(root: string, profile: string): GatewayPlatforms {
  const platforms: GatewayPlatforms =
    profile === 'default' ? {} : { ...readGatewayPlatforms(join(root, 'profiles', profile)) }
  for (const [key, value] of Object.entries(readGatewayPlatforms(root))) {
    if (key.startsWith(`${profile}:`)) platforms[key.slice(profile.length + 1)] = value
    else if (profile === 'default' && !key.includes(':')) platforms[key] = value
  }
  return platforms
}

/** Known platforms first (disconnected by default), then whatever the gateway reports. */
export function messagingRows(platforms: GatewayPlatforms): ConnectionsResponse['messaging'] {
  const rows = new Map<string, ConnectionsResponse['messaging'][number]>()
  for (const [platform, label] of Object.entries(PLATFORMS))
    rows.set(platform, { platform, label, status: 'disconnected', detail: null })
  for (const [key, value] of Object.entries(platforms)) {
    // Multiplexed gateways key platforms as "<profile>:<platform>".
    const platform = key.split(':').pop()!
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(platform)) continue
    const connected = value.state === 'connected'
    if (rows.get(platform)?.status === 'connected') continue
    const problem = value.error_code ?? value.error_message
    rows.set(platform, {
      platform,
      label: PLATFORMS[platform] ?? title(platform),
      status: connected ? 'connected' : 'disconnected',
      detail: connected ? null : redactBounded(String(problem ?? value.state ?? ''), 200) || null,
    })
  }
  return [...rows.values()]
}

/** The credential ids `auth list` shows under one provider's header (`#1 <label> api_key id=<id> priority=…`). */
export function credentialIds(text: string, provider: string): string[] {
  const ids: string[] = []
  let inside = false
  for (const line of text.split(/\r?\n/)) {
    const header = HEADER.exec(line)
    if (header) {
      inside = header[1] === provider
      continue
    }
    if (!line.startsWith(' ')) inside = false
    const row = inside
      ? /^\s+#\d+\s+.+?\s+(?:oauth|api_key)\s+id=(\S+)\s+priority=/.exec(line)
      : null
    if (row && /^[A-Za-z0-9._:-]{1,128}$/.test(row[1]!)) ids.push(row[1]!)
  }
  return ids
}

export class LiveSettings {
  private readonly home: string
  constructor(
    hermesHome: string | undefined,
    private readonly runner: HermesRunner = runHermes,
    /** Every provider Hermes supports (from the gateway); null when it can't be read. */
    private readonly providerCatalog: () => Promise<
      { slug: string; name: string; auth_type?: string | undefined }[] | null
    > = async () => null,
    /** The profile whose credentials the provider routes act on; none = Hermes's default. */
    private readonly profile?: string,
    private readonly spawner: HermesSpawner = spawnHermes,
    private readonly locks: ProfileLocks = new ProfileLocks(),
  ) {
    this.home = resolveHermesHome(hermesHome)
    this.signIns = new SignInManager({
      spawn: this.spawner,
      hermesHome: this.home,
      profileArgs: this.profileArgs(),
      isConnected: async (id) =>
        (await this.pooled()).some((item) => item.id === id && item.status === 'connected'),
    })
  }
  private readonly signIns: SignInManager
  private readonly keyInFlight = new Set<string>()
  /** Key children still running, so shutdown can stop them (audit 2026-10-08). */
  private readonly keyChildren = new Set<HermesChild>()
  private closed = false
  private admit(): void {
    if (this.closed)
      throw new HttpError(
        503,
        'unavailable',
        'Score is shutting down. Try again once it has restarted.',
      )
  }
  private profileArgs(): string[] {
    return this.profile ? ['-p', this.profile] : []
  }
  /** Stops admitting sign-ins and stops every child still running: device sign-ins and pasted-key adds. */
  close(): void {
    this.closed = true
    this.signIns.close()
    for (const child of this.keyChildren) child.kill()
  }

  private async read(args: string[], fresh = false): Promise<string | null> {
    const result = await this.runner([...this.profileArgs(), ...args], {
      timeoutMs: READ_TIMEOUT_MS,
      hermesHome: this.home,
      captureSettings: true,
      ...(fresh ? { fresh: true } : {}),
    })
    return result.exitCode === 0 && result.stdout !== undefined ? result.stdout : null
  }
  private async readJson(args: string[], fresh = false): Promise<unknown> {
    const text = await this.read(args, fresh)
    if (text === null) return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  /** The last `auth list` that answered: a failed or timed-out read keeps it instead of showing everything missing. */
  private lastAuthList: string | null = null
  private async pooled(): Promise<ProviderBase[]> {
    const text = (await this.read(['auth', 'list'])) ?? this.lastAuthList
    this.lastAuthList = text
    const found = new Map<string, { n: number; failed: number; oauth: boolean }>()
    const free: ProviderBase[] = []
    let current: { n: number; failed: number; oauth: boolean } | undefined
    for (const line of (text ?? '').split(/\r?\n/)) {
      const header = HEADER.exec(line)
      if (header) {
        current = { n: 0, failed: 0, oauth: false }
        found.set(header[1]!, current)
        continue
      }
      const row = ROW.exec(line)
      if (row && current) {
        current.n++
        current.oauth ||= row[1] === 'oauth'
        if (/auth failed|re-auth/i.test(row[2]!)) current.failed++
        continue
      }
      const note = FREE_TIER.exec(line)
      if (note && !line.startsWith(' ')) {
        current = undefined
        free.push({
          id: note[1]!,
          label: CATALOG[note[1]!] ?? title(note[1]!),
          status: 'connected',
          detail: redactBounded(note[2]!, 120),
        })
      }
    }
    const items: ProviderBase[] = [...free]
    for (const [id, entry] of found) {
      if (entry.n === 0) continue
      items.push({
        id,
        label: CATALOG[id] ?? title(id),
        status: entry.failed === entry.n ? 'needs_signin' : 'connected',
        detail:
          id === 'openai-codex'
            ? 'Your ChatGPT plan'
            : entry.oauth
              ? 'Signed in'
              : `API key (${entry.n})`,
      })
    }
    return items
  }
  private async localProviders(): Promise<ProviderBase[]> {
    const parsed = LocalProvidersSchema.safeParse(
      await this.readJson(['config', 'get', '--json', 'providers']),
    )
    if (!parsed.success) return []
    const items: ProviderBase[] = []
    for (const [id, entry] of Object.entries(parsed.data)) {
      if (!ProviderIdSchema.safeParse(id).success || !entry.base_url) continue
      // Hermes masks the key on read: only whether one is set is used, never its value.
      const key = (entry as { api_key?: unknown }).api_key
      items.push({
        id,
        label: redactBounded(entry.name?.trim() || title(id), 80),
        status: 'connected',
        detail: redactBounded(hostOf(entry.base_url), 120),
        keySet: typeof key === 'string' && key.length > 0,
      })
    }
    return items
  }

  async listProviders(): Promise<ProviderBase[]> {
    const [pooled, local] = await Promise.all([this.pooled(), this.localProviders()])
    const items = new Map<string, ProviderBase>()
    // Hermes's own list when the gateway answers; the short built-in list only as a fallback.
    const catalog = await this.providerCatalog().catch(() => null)
    const entries = catalog?.length
      ? catalog
          .filter(
            (entry) => entry.slug !== 'custom' && ProviderIdSchema.safeParse(entry.slug).success,
          )
          .map((entry) => [entry.slug, entry.name, entry.auth_type] as const)
      : Object.entries(CATALOG).map(
          ([id, label]) =>
            [id, label, FALLBACK_KEY_PROVIDERS.has(id) ? 'api_key' : undefined] as const,
        )
    const kinds = new Map<string, SignInKind>()
    for (const [id, label, authType] of entries) {
      items.set(id, { id, label, status: 'missing', detail: 'Not connected' })
      kinds.set(id, signInKind(id, authType))
    }
    for (const item of pooled) items.set(item.id, item)
    // Local endpoints have no sign-in of their own, and no `signIn` either: that is how the web tells them apart (2.0.3).
    const localIds = new Set(local.map((item) => item.id))
    for (const item of local) {
      items.set(item.id, item)
      kinds.delete(item.id)
    }
    return [...items.values()].map((item) =>
      localIds.has(item.id) ? item : { ...item, signIn: kinds.get(item.id) ?? 'terminal' },
    )
  }
  /** The sign-in kind of one provider, from the gateway catalog (or the built-in list). */
  private async kindOf(id: string): Promise<SignInKind | null> {
    const catalog = await this.providerCatalog().catch(() => null)
    const entry = catalog?.find((candidate) => candidate.slug === id)
    if (entry) return signInKind(id, entry.auth_type)
    if (!catalog?.length && id in CATALOG)
      return signInKind(id, FALLBACK_KEY_PROVIDERS.has(id) ? 'api_key' : undefined)
    // Connected through other means (pooled credentials, local endpoints): known, but no browser sign-in.
    return (await this.listProviders()).some((item) => item.id === id) ? 'terminal' : null
  }

  async connectProvider(id: string): Promise<ConnectResult> {
    const providerId = ProviderIdSchema.safeParse(id)
    if (!providerId.success) throw new HttpError(404, 'not_found', 'Couldn’t find that provider.')
    // The catalog alone answers "is this a provider?"; the full list would spawn two Hermes processes.
    const kind = await this.kindOf(providerId.data)
    if (kind === null) throw new HttpError(404, 'not_found', 'Couldn’t find that provider.')
    // The terminal command is always included: it is the fallback for every provider (ARCHITECTURE D2.7).
    const command = `hermes auth add ${providerId.data}`
    if (kind !== 'device_code') return { next: 'run_in_terminal', command }
    // Checked after the awaits above: shutdown may have started while the catalog was being read.
    this.admit()
    const signIn = await this.signIns.start(providerId.data)
    // Hermes imported an existing credential: nothing left to do (the command stays as a courtesy).
    if (signIn.state === 'connected') return { next: 'done', command }
    if (signIn.state !== 'waiting' || !signIn.url || !signIn.code)
      return { next: 'run_in_terminal', command }
    return {
      next: 'device_code',
      command,
      url: signIn.url,
      code: signIn.code,
      signInId: signIn.id,
      expiresAt: signIn.expiresAt,
    }
  }
  async getSignIn(id: string): Promise<SignIn> {
    return this.signIns.get(id)
  }
  async cancelSignIn(id: string): Promise<SignIn> {
    return this.signIns.cancel(id)
  }

  /**
   * Relays a pasted key to `hermes auth add <id> --type api-key` on stdin (ARCHITECTURE D2.7). The key lives only in
   * this call: not in argv or the environment, and nothing the process prints is read or kept.
   */
  async addProviderKey(id: string, req: ProviderKeyRequest): Promise<ProviderBase> {
    const providerId = ProviderIdSchema.safeParse(id)
    if (!providerId.success) throw new HttpError(404, 'not_found', 'Couldn’t find that provider.')
    const kind = await this.kindOf(providerId.data)
    if (kind === null) throw new HttpError(404, 'not_found', 'Couldn’t find that provider.')
    if (kind !== 'api_key')
      throw new HttpError(
        409,
        'not_supported',
        'This provider doesn’t take a pasted key. Use its sign-in instead.',
      )
    this.admit()
    if (this.keyInFlight.has(providerId.data))
      throw new HttpError(409, 'conflict', 'A key is already being added for this provider.')
    this.keyInFlight.add(providerId.data)
    try {
      const label = req.label ?? `score-${new Date().toISOString().slice(0, 10)}`
      const child = this.spawner(
        [
          ...this.profileArgs(),
          'auth',
          'add',
          providerId.data,
          '--type',
          'api-key',
          '--label',
          label,
        ],
        { hermesHome: this.home, input: `${req.apiKey}\n` },
      )
      this.keyChildren.add(child)
      const timer = setTimeout(() => child.kill(), KEY_TIMEOUT_MS)
      const code = await child.exited.finally(() => {
        clearTimeout(timer)
        this.keyChildren.delete(child)
      })
      const item =
        code === 0
          ? (await this.pooled()).find(
              (candidate) => candidate.id === providerId.data && candidate.status === 'connected',
            )
          : undefined
      if (!item) throw new HttpError(409, 'not_verified', 'Hermes didn’t accept that key.')
      return { ...item, signIn: 'api_key' }
    } finally {
      this.keyInFlight.delete(providerId.data)
    }
  }

  async addLocalProvider(req: LocalProviderRequest): Promise<ProviderBase> {
    const slug = slugify(req.label)
    if (!ProviderIdSchema.safeParse(slug).success)
      throw new HttpError(
        400,
        'bad_request',
        'Couldn’t read that request. Check what you entered and try again.',
      )
    const exists = async () =>
      slug in CATALOG || (await this.listProviders()).some((item) => item.id === slug)
    const taken = () => new HttpError(409, 'conflict', 'A provider with that name already exists.')
    if (await exists()) throw taken()
    const base = `providers.${slug}`
    await this.locks.run(this.profile ?? 'default', async () => {
      // Checked again under the lock: two requests can both pass the early check and the second would
      // overwrite the first's provider.
      if (await exists()) throw taken()
      for (const [key, value] of [
        ['name', req.label],
        ['base_url', req.baseUrl],
        ['default_model', req.model],
      ] as const) {
        const result = await this.runner(
          [...this.profileArgs(), 'config', 'set', `${base}.${key}`, value],
          { timeoutMs: READ_TIMEOUT_MS, hermesHome: this.home },
        )
        if (result.exitCode !== 0)
          throw new HttpError(502, 'hermes_write_failed', 'Hermes didn’t accept the provider.')
      }
      if (req.apiKey !== undefined) {
        // The key is an argv element only: never captured, logged or returned (2.0.10).
        const argv = [...this.profileArgs(), 'config', 'set', `${base}.api_key`, req.apiKey]
        const result = await this.runner(argv, {
          timeoutMs: READ_TIMEOUT_MS,
          hermesHome: this.home,
          sensitiveArgIndices: [argv.length - 1],
        }).catch(() => ({ exitCode: -1 }))
        if (result.exitCode !== 0)
          throw new HttpError(
            502,
            'hermes_write_failed',
            'The model was added, but Hermes didn’t accept its key. Use Add key on its row.',
          )
      }
      const kept = (await this.localProviders()).some((item) => item.id === slug)
      if (!kept) throw new HttpError(502, 'hermes_write_failed', 'Hermes didn’t keep the provider.')
    })
    return {
      id: slug,
      label: redactBounded(req.label, 80),
      status: 'connected',
      detail: redactBounded(hostOf(req.baseUrl), 120),
      keySet: req.apiKey !== undefined,
    }
  }

  /**
   * Removes a hosted provider's stored credentials (2.0.3): `auth remove <id> <credential id>` for each one `auth list`
   * shows, then `auth logout <id>` if a sign-in is still listed, then a fresh `auth list` must not show the provider.
   * Hermes may clear the provider's key from the profile's env as part of this; Score never reads it.
   */
  async removeHostedProvider(id: string): Promise<void> {
    const provider = ProviderIdSchema.parse(id)
    await this.locks.run(this.profile ?? 'default', async () => {
      const text = await this.read(['auth', 'list'], true)
      if (text === null)
        throw new HttpError(502, 'hermes_unavailable', 'Couldn’t read the stored sign-ins.')
      const credentials = credentialIds(text, provider)
      if (credentials.length === 0)
        throw new HttpError(409, 'not_supported', 'Nothing is stored for this provider.')
      for (const credential of credentials)
        await this.runner([...this.profileArgs(), 'auth', 'remove', provider, credential], {
          timeoutMs: READ_TIMEOUT_MS,
          hermesHome: this.home,
        }).catch(() => ({ exitCode: -1 }))
      let left = await this.read(['auth', 'list'], true)
      if (left !== null && credentialIds(left, provider).length > 0) {
        await this.runner([...this.profileArgs(), 'auth', 'logout', provider], {
          timeoutMs: READ_TIMEOUT_MS,
          hermesHome: this.home,
        }).catch(() => ({ exitCode: -1 }))
        left = await this.read(['auth', 'list'], true)
      }
      if (left === null || credentialIds(left, provider).length > 0)
        throw new HttpError(409, 'not_verified', 'Hermes still lists a sign-in for this provider.')
      this.lastAuthList = left
    })
  }
  /**
   * `mcp remove <id>` (2.0.3). Hermes asks "Remove server?" and has no flag to skip it: stdin is closed so it takes its
   * default (yes); the person already confirmed in Score. Its exit code doesn't say whether the server existed, so a
   * fresh read of `mcp_servers` decides.
   */
  async removeToolServer(id: string): Promise<void> {
    const name = z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
      .parse(id)
    await this.locks.run(this.profile ?? 'default', async () => {
      const before = ServersSchema.safeParse(
        await this.readJson(['config', 'get', '--json', 'mcp_servers'], true),
      )
      if (!before.success)
        throw new HttpError(502, 'hermes_unavailable', 'Couldn’t read the tool servers.')
      if (!Object.hasOwn(before.data, name))
        throw new HttpError(404, 'not_found', 'Couldn’t find that tool server.')
      await this.runner([...this.profileArgs(), 'mcp', 'remove', name], {
        timeoutMs: READ_TIMEOUT_MS,
        hermesHome: this.home,
        closeStdin: true,
      }).catch(() => ({ exitCode: -1 }))
      // Exit 1 = the key is unset now (the last server went); any other failure says nothing, so it is not a success.
      const after = await this.runner(
        [...this.profileArgs(), 'config', 'get', '--json', 'mcp_servers'],
        { timeoutMs: READ_TIMEOUT_MS, hermesHome: this.home, captureSettings: true, fresh: true },
      )
      let left: Record<string, unknown> | null = null
      if (after.exitCode === 0 && after.stdout !== undefined) {
        try {
          const parsed = ServersSchema.safeParse(JSON.parse(after.stdout))
          if (parsed.success) left = parsed.data
        } catch {
          /* unreadable: left stays null */
        }
      } else if (after.exitCode === 1) left = {}
      if (left === null)
        throw new HttpError(
          502,
          'hermes_unavailable',
          'Couldn’t check that the tool server is gone.',
        )
      if (Object.hasOwn(left, name))
        throw new HttpError(409, 'not_verified', 'Hermes still lists that tool server.')
    })
  }

  async listConnections(): Promise<ConnectionsResponse> {
    return { toolServers: await this.toolServers(), messaging: this.messaging() }
  }
  private async toolServers(): Promise<ConnectionsResponse['toolServers']> {
    const parsed = ServersSchema.safeParse(
      await this.readJson(['config', 'get', '--json', 'mcp_servers']),
    )
    if (!parsed.success) return []
    return Object.entries(parsed.data)
      .filter(([name]) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name))
      .map(([name, config]) => {
        // Only presence of a launch target is read; env and header values stay unread.
        const target = z
          .object({ command: z.unknown().optional(), url: z.unknown().optional() })
          .safeParse(config)
        const launchable = target.success && Boolean(target.data.command || target.data.url)
        return {
          id: name,
          label: redact(name),
          status: launchable ? ('ok' as const) : ('error' as const),
          usedBy: 'everyone' as const,
        }
      })
  }
  private messaging(): ConnectionsResponse['messaging'] {
    return messagingRows(readProfilePlatforms(this.home, this.profile ?? 'default'))
  }

  connectMessaging(platform: string): ConnectResult {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(platform))
      throw new HttpError(404, 'not_found', 'Couldn’t find that messaging platform.')
    // Token-based platforms are set up in the browser form; pairings (QR codes) still need the terminal.
    if (messagingFields(platform).browserSetup) return { next: 'form' }
    return { next: 'run_in_terminal', command: 'hermes gateway setup' }
  }
  addToolServer(req: ToolServerRequest): ConnectResult {
    const args = req.url
      ? ['--url', req.url]
      : [
          '--command',
          req.command![0]!,
          ...(req.command!.length > 1 ? ['--args'] : []),
          ...req.command!.slice(1),
        ]
    return {
      next: 'run_in_terminal',
      command: ['hermes', 'mcp', 'add', req.name, ...args].map(quote).join(' '),
    }
  }
}
