import type {
  ConnectResult,
  LocalProviderRequest,
  ProviderKeyRequest,
  SignIn,
} from '@score/contract'
import { HttpError } from '../../errors.ts'
import { redactBounded } from '../../redact.ts'
import type { ProviderBase } from '../port.ts'
import { LiveSettingsBase } from './settings-base.ts'
import {
  CATALOG,
  FALLBACK_KEY_PROVIDERS,
  KEY_TIMEOUT_MS,
  LocalProvidersSchema,
  ProviderIdSchema,
  READ_TIMEOUT_MS,
  type SignInKind,
  credentialIds,
  hostOf,
  signInKind,
  slugify,
  title,
} from './settings-catalog.ts'

export abstract class LiveSettingsProviders extends LiveSettingsBase {
  /** The ids of this profile's local providers, read now; null when Hermes can't be read (callers that write stop). */
  async localProviderIds(): Promise<Set<string> | null> {
    const result = await this.runner(
      [...this.profileArgs(), 'config', 'get', '--json', 'providers'],
      { timeoutMs: READ_TIMEOUT_MS, hermesHome: this.home, captureSettings: true, fresh: true },
    ).catch(() => ({ exitCode: -1 }))
    // Exit 1 = no `providers` section at all: no local providers, not a failed read.
    if (result.exitCode === 1) return new Set()
    if (result.exitCode !== 0 || !('stdout' in result) || result.stdout === undefined) return null
    try {
      const parsed = LocalProvidersSchema.safeParse(JSON.parse(result.stdout))
      if (!parsed.success) return null
      // The same rule as the provider list: an entry with an address (a bare override of a hosted one isn't local).
      return new Set(
        Object.entries(parsed.data)
          .filter(([id, entry]) => ProviderIdSchema.safeParse(id).success && entry.base_url)
          .map(([id]) => id),
      )
    } catch {
      return null
    }
  }
  private async localProviders(): Promise<ProviderBase[]> {
    const parsed = LocalProvidersSchema.safeParse(
      await this.readJson(['config', 'get', '--json', 'providers']),
    )
    if (!parsed.success) return []
    const items: ProviderBase[] = []
    for (const [id, entry] of Object.entries(parsed.data)) {
      if (!ProviderIdSchema.safeParse(id).success || !entry.base_url) continue
      // Hermes masks the key on read: only whether one is set is used, never its value. Any of Hermes's key sources
      // counts (inline, an env name, a command).
      const fields = entry as Record<string, unknown>
      const keyed = ['api_key', 'key_env', 'api_key_env', 'key_cmd'].some(
        (name) => typeof fields[name] === 'string' && (fields[name] as string).length > 0,
      )
      items.push({
        id,
        label: redactBounded(entry.name?.trim() || title(id), 80),
        status: 'connected',
        detail: redactBounded(hostOf(entry.base_url), 120),
        keySet: keyed,
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
}
