import fs from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type {
  ConnectResult,
  ConnectionsResponse,
  LocalProviderRequest,
  ToolServerRequest,
} from '@score/contract'
import { HttpError } from '../../errors.ts'
import { redact, redactBounded } from '../../redact.ts'
import { runHermes, type HermesRunner } from './cli.ts'
import { resolveHermesHome } from './paths.ts'
import type { ProviderBase } from '../port.ts'

// Provider and connection status comes from Hermes itself: `hermes auth list` (labels and counts, never key
// material), `hermes config get --json …` (Hermes masks secret-shaped values) and the gateway's runtime
// status file. Score never opens .env, auth.json or any credential store.
const MAX_STATE_BYTES = 1024 * 1024
const READ_TIMEOUT_MS = 8000
const ProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)

// Providers worth showing even when Hermes has no credential for them yet.
const CATALOG: Record<string, string> = {
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  'openai-codex': 'ChatGPT (Codex)',
  nous: 'Nous Portal',
}
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

export class LiveSettings {
  private readonly home: string
  constructor(
    hermesHome: string | undefined,
    private readonly runner: HermesRunner = runHermes,
    /** Every provider Hermes supports (from the gateway); null when it can't be read. */
    private readonly providerCatalog: () => Promise<
      { slug: string; name: string }[] | null
    > = async () => null,
  ) {
    this.home = resolveHermesHome(hermesHome)
  }

  private async read(args: string[]): Promise<string | null> {
    const result = await this.runner(args, {
      timeoutMs: READ_TIMEOUT_MS,
      hermesHome: this.home,
      captureSettings: true,
    })
    return result.exitCode === 0 && result.stdout !== undefined ? result.stdout : null
  }
  private async readJson(args: string[]): Promise<unknown> {
    const text = await this.read(args)
    if (text === null) return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  private async pooled(): Promise<ProviderBase[]> {
    const text = await this.read(['auth', 'list'])
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
      items.push({
        id,
        label: redactBounded(entry.name?.trim() || title(id), 80),
        status: 'connected',
        detail: redactBounded(hostOf(entry.base_url), 120),
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
          .map((entry) => [entry.slug, entry.name] as const)
      : Object.entries(CATALOG)
    for (const [id, label] of entries)
      items.set(id, { id, label, status: 'missing', detail: 'Not connected' })
    for (const item of [...pooled, ...local]) items.set(item.id, item)
    return [...items.values()]
  }

  async connectProvider(id: string): Promise<ConnectResult> {
    const providerId = ProviderIdSchema.safeParse(id)
    if (!providerId.success) throw new HttpError(404, 'not_found', 'Unknown provider')
    // The catalog alone answers "is this a provider?"; the full list would spawn two Hermes processes.
    const catalog = await this.providerCatalog().catch(() => null)
    const known =
      (catalog?.some((entry) => entry.slug === providerId.data) ?? false) ||
      providerId.data in CATALOG ||
      (await this.listProviders()).some((item) => item.id === providerId.data)
    if (!known) throw new HttpError(404, 'not_found', 'Unknown provider')
    // Sign-in prompts for keys or opens a browser: only the person can do it, in their own terminal.
    return { next: 'run_in_terminal', command: `hermes auth add ${providerId.data}` }
  }

  async addLocalProvider(req: LocalProviderRequest): Promise<ProviderBase> {
    const slug = slugify(req.label)
    if (!ProviderIdSchema.safeParse(slug).success)
      throw new HttpError(400, 'bad_request', 'Invalid request')
    if (slug in CATALOG || (await this.listProviders()).some((item) => item.id === slug))
      throw new HttpError(409, 'conflict', 'A provider with that name already exists')
    const base = `providers.${slug}`
    for (const [key, value] of [
      ['name', req.label],
      ['base_url', req.baseUrl],
      ['default_model', req.model],
    ] as const) {
      const result = await this.runner(['config', 'set', `${base}.${key}`, value], {
        timeoutMs: READ_TIMEOUT_MS,
        hermesHome: this.home,
      })
      if (result.exitCode !== 0)
        throw new HttpError(502, 'hermes_write_failed', 'Hermes did not accept the provider')
    }
    return {
      id: slug,
      label: redactBounded(req.label, 80),
      status: 'connected',
      detail: redactBounded(hostOf(req.baseUrl), 120),
    }
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
    const rows = new Map<string, ConnectionsResponse['messaging'][number]>()
    for (const [platform, label] of Object.entries(PLATFORMS))
      rows.set(platform, { platform, label, status: 'disconnected', detail: null })
    for (const [key, value] of Object.entries(this.gatewayPlatforms())) {
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
  private gatewayPlatforms(): NonNullable<z.infer<typeof StateSchema>['platforms']> {
    try {
      const path = join(this.home, 'gateway_state.json')
      if (fs.statSync(path).size > MAX_STATE_BYTES) return {}
      return StateSchema.parse(JSON.parse(fs.readFileSync(path, 'utf8'))).platforms ?? {}
    } catch {
      return {}
    }
  }

  connectMessaging(platform: string): ConnectResult {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(platform))
      throw new HttpError(404, 'not_found', 'Unknown platform')
    // Setup asks for bot tokens and pairing codes; Score never handles them.
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
