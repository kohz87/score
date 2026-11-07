import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import { configJson, readLocalProviderIds } from './agent-config.ts'
import { AgentTabsCore } from './agent-tabs-core.ts'
import { ProfileNameSchema } from './paths.ts'

// A local provider's key under `providers.`: no dots, since Hermes reads a dot as a nested key.
const LocalProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)

/** Local provider copies, keys and removal for one Hermes profile. */
export abstract class AgentTabsProviders extends AgentTabsCore {
  /**
   * Copies a local provider the default profile defines into another profile: its name, address and default model,
   * nothing else (a key, if any, stays where it is). Under that profile's config lock.
   */
  async copyLocalProvider(
    profile: string,
    providerId: string,
    source = 'default',
    keyFollows = false,
  ): Promise<void> {
    const parsed = ProfileNameSchema.parse(profile)
    if (parsed === source) return
    await this.serial(parsed, async () => {
      const own = await readLocalProviderIds(this.runner, this.hermesHome, parsed)
      if (own === null)
        throw new HttpError(502, 'hermes_unavailable', 'Couldn’t read the agent’s providers.')
      if (!own.has(providerId))
        await this.copyProviderUnlocked(parsed, providerId, source, keyFollows)
    })
  }
  /**
   * Writes a local provider's API key into one profile that defines it (2.0.10). The key is an argv element only: never
   * captured, logged or returned.
   */
  async setLocalProviderKey(profile: string, providerId: string, apiKey: string): Promise<void> {
    const parsed = ProfileNameSchema.parse(profile)
    const id = LocalProviderIdSchema.parse(providerId)
    await this.serial(parsed, async () => {
      const argv = ['-p', parsed, 'config', 'set', `providers.${id}.api_key`, apiKey]
      const result = await this.runner(argv, {
        timeoutMs: 15000,
        hermesHome: this.hermesHome,
        sensitiveArgIndices: [argv.length - 1],
      }).catch(() => ({ exitCode: -1 }))
      this.invalidate(parsed)
      if (result.exitCode !== 0)
        throw new HttpError(502, 'hermes_write_failed', 'Hermes didn’t accept the key.')
    })
  }
  /** Whether the profile's entry for this local provider has a key (masked on read); null when unknown. */
  async localProviderKeyed(profile: string, providerId: string): Promise<boolean | null> {
    const read = await configJson(this.runner, this.hermesHome, profile, 'providers')
    if (read.state !== 'ok' || !read.value || typeof read.value !== 'object') return null
    const entry = (read.value as Record<string, unknown>)[providerId]
    if (!entry || typeof entry !== 'object') return null
    // Any of Hermes's key sources counts (inline, an env name, a command), not just the inline key Score writes.
    const fields = entry as Record<string, unknown>
    return ['api_key', 'key_env', 'api_key_env', 'key_cmd'].some(
      (name) => typeof fields[name] === 'string' && (fields[name] as string).length > 0,
    )
  }
  /** Whether the profile's config defines this local provider; null when it can't be read. */
  async definesLocalProvider(profile: string, providerId: string): Promise<boolean | null> {
    const own = await readLocalProviderIds(
      this.runner,
      this.hermesHome,
      ProfileNameSchema.parse(profile),
    )
    return own === null ? null : own.has(providerId)
  }
  /**
   * `config unset providers.<id>` in one profile (2.0.3): always the full key, never `providers` itself (that would drop
   * every local provider). A dotted id would address a nested key, so it is refused.
   */
  async removeLocalProvider(profile: string, providerId: string): Promise<void> {
    const parsed = ProfileNameSchema.parse(profile)
    const id = LocalProviderIdSchema.parse(providerId)
    await this.serial(parsed, () => this.mutate(parsed, ['config', 'unset', `providers.${id}`]))
    if ((await this.definesLocalProvider(parsed, id)) !== false)
      throw new HttpError(409, 'not_verified', 'Hermes still lists that provider.')
  }
  protected async copyProviderUnlocked(
    profile: string,
    providerId: string,
    from = 'default',
    // The caller writes the key right after (adding a provider with its key): don't refuse for a missing one.
    keyFollows = false,
  ): Promise<void> {
    const id = LocalProviderIdSchema.parse(providerId)
    // The whole section: only `providers` is an allowlisted read (cli.ts); just three fields of one entry are used.
    const read = await configJson(this.runner, this.hermesHome, from, 'providers')
    const entry =
      read.state === 'ok' && read.value && typeof read.value === 'object'
        ? (read.value as Record<string, unknown>)[id]
        : undefined
    if (entry === undefined)
      throw new HttpError(502, 'hermes_unavailable', 'Couldn’t read that local provider.')
    const source = z
      .object({
        name: z.string().min(1).max(200).optional(),
        base_url: z.string().min(1).max(2000),
        default_model: z.string().min(1).max(256).optional(),
        api_key: z.string().optional(),
      })
      .safeParse(entry)
    if (!source.success)
      throw new HttpError(
        409,
        'conflict',
        'That local provider can’t be copied: its settings are incomplete.',
      )
    // The address first: Hermes (and Score's list) ignore an entry without one, so a copy cut short is either usable
    // or invisible, never a half entry that `own.has` would mistake for a finished copy.
    const fields: [string, string][] = [
      ['base_url', source.data.base_url],
      ['name', source.data.name ?? id],
      ...(source.data.default_model
        ? [['default_model', source.data.default_model] as [string, string]]
        : []),
    ]
    for (const [key, value] of fields)
      await this.mutate(profile, ['config', 'set', `providers.${id}.${key}`, value])
    // Hermes masks a key on read, so it can't be copied; an env placeholder (${VAR}) is not a key and copies as is.
    const key = source.data.api_key ?? ''
    if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(key))
      await this.mutate(profile, ['config', 'set', `providers.${id}.api_key`, key])
    else if (key && !keyFollows)
      throw new HttpError(
        409,
        'needs_key',
        `${source.data.name ?? id} needs its API key for this agent. Add the key again in Settings › Connections: it is given to every agent.`,
      )
  }
}
