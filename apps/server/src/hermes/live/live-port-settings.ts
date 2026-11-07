import type { HermesCheck, MessagingSetupRequest, ModelRef } from '@score/contract'
import { HttpError } from '../../errors.ts'
import type { AgentFile, AgentFileName } from '../agent-files.ts'
import { messagingFields, messagingWrites } from '../messaging-fields.ts'
import { KNOWN_PATTERN_KEYS } from '../pattern-keys.ts'
import type { HermesPort } from '../port.ts'
import {
  computeFingerprint,
  testedFingerprints,
  type Fingerprint,
  type TestedFingerprint,
} from './fingerprint.ts'
import { buildHermesCheck, type HermesCheckResult } from './hermes-check.ts'
import { removeMessagingValues, saveMessagingValues } from './messaging.ts'
import { ProfileNameSchema, resolveHermesHome } from './paths.ts'
import { removeProviderAcross } from './remove-provider.ts'
import { hermesSourceDir, readSourceFacts } from './source-facts.ts'
import type { LivePortRuntime } from './live-port-runtime.ts'

export const settingsMethods = {
  async listProviders(this: LivePortRuntime) {
    return this.settings.listProviders()
  },
  async listModels(this: LivePortRuntime, q?: string, only?: readonly ModelRef[], limit?: number) {
    return this.models.list(q, only, limit)
  },
  async connectProvider(this: LivePortRuntime, id: string) {
    return this.settings.connectProvider(id)
  },
  async getSignIn(this: LivePortRuntime, id: string) {
    return this.settings.getSignIn(id)
  },
  async cancelSignIn(this: LivePortRuntime, id: string) {
    return this.settings.cancelSignIn(id)
  },
  async addProviderKey(
    this: LivePortRuntime,
    id: string,
    req: Parameters<HermesPort['addProviderKey']>[1],
  ) {
    // A local provider's key goes into every profile that defines it (2.0.10); a hosted one through `auth add`. Local
    // is what the provider list says (an item with `keySet`), not merely a `providers.<id>` entry somewhere, which can
    // be an override of a hosted provider.
    // A failed read must not look like "not local": the key would go down the hosted path.
    const localIds = await this.settings.localProviderIds()
    if (localIds === null)
      throw new HttpError(
        502,
        'hermes_unavailable',
        'Couldn’t read the providers, so the key wasn’t saved. Try again.',
      )
    if (!localIds.has(id)) return this.settings.addProviderKey(id, req)
    const profiles = this.profiles.names(this.current.hermes.servedProfiles)
    const answers = await Promise.all(
      profiles.map((profile) => this.tabs.definesLocalProvider(profile, id).catch(() => null)),
    )
    // An unreadable profile might hold a copy that would miss the key: stop rather than guess.
    if (answers.some((answer) => answer === null))
      throw new HttpError(
        502,
        'hermes_unavailable',
        'Couldn’t read every agent’s providers, so the key wasn’t saved. Try again.',
      )
    const local = profiles.filter((_, at) => answers[at] === true)
    if (local.length === 0) throw new HttpError(404, 'not_found', 'Couldn’t find that provider.')
    for (const profile of local) await this.tabs.setLocalProviderKey(profile, id, req.apiKey)
    this.profiles.invalidate(this.options.settingsProfile ?? 'default')
    const item = (await this.settings.listProviders()).find((provider) => provider.id === id)
    if (!item) throw new HttpError(404, 'not_found', 'Couldn’t find that provider.')
    return item
  },
  async addLocalProvider(
    this: LivePortRuntime,
    req: Parameters<HermesPort['addLocalProvider']>[0],
  ) {
    const provider = await this.settings.addLocalProvider(req)
    // Every agent can use it (2.0.3). A copy that fails here is made again when an agent picks the provider's model;
    // the key (2.0.10) is written to each copy right away, since Hermes masks it and it can't be copied later.
    const source = this.options.settingsProfile ?? 'default'
    await Promise.all(
      this.profiles
        .names(this.current.hermes.servedProfiles)
        .filter((profile) => profile !== source)
        .map(async (profile) => {
          try {
            await this.tabs.copyLocalProvider(
              profile,
              provider.id,
              source,
              req.apiKey !== undefined,
            )
            if (req.apiKey !== undefined)
              await this.tabs.setLocalProviderKey(profile, provider.id, req.apiKey)
          } catch {
            /* made again when an agent picks the model; a missing key then says so */
          }
        }),
    )
    return provider
  },
  // A race with a model change that picks this provider between the route's in-use check and here is accepted: one
  // person drives Score, and the agent's next turn would say its provider is gone.
  async removeProvider(this: LivePortRuntime, id: string) {
    const settingsProfile = this.options.settingsProfile ?? 'default'
    try {
      await removeProviderAcross(id, {
        profiles: this.profiles.names(this.current.hermes.servedProfiles),
        defines: (profile, provider) => this.tabs.definesLocalProvider(profile, provider),
        removeLocal: (profile, provider) => this.tabs.removeLocalProvider(profile, provider),
        removeHosted: (provider) => this.settings.removeHostedProvider(provider),
      })
    } finally {
      this.profiles.invalidate(settingsProfile)
    }
  },
  async removeToolServer(this: LivePortRuntime, id: string) {
    try {
      await this.settings.removeToolServer(id)
    } finally {
      this.profiles.invalidate(this.options.settingsProfile ?? 'default')
    }
  },
  async removeMessaging(this: LivePortRuntime, platform: string, agentId?: string) {
    const { fields, browserSetup } = messagingFields(platform)
    if (!browserSetup)
      throw new HttpError(
        409,
        'not_supported',
        'Remove this one in the terminal: hermes gateway setup.',
      )
    let profile = this.options.settingsProfile
    if (agentId !== undefined) {
      const parsed = ProfileNameSchema.safeParse(agentId)
      if (!parsed.success || !this.profiles.profileHome(parsed.data))
        throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
      profile = parsed.data
    }
    return removeMessagingValues({
      hermesHome: resolveHermesHome(this.options.hermesHome),
      profile,
      platform,
      keys: fields.map((field) => field.key),
      runner: this.options.runner,
      locks: this.locks,
      invalidate: () => profile && this.profiles.invalidate(profile),
    })
  },
  async listConnections(this: LivePortRuntime) {
    return this.settings.listConnections()
  },
  async addToolServer(this: LivePortRuntime, req: Parameters<HermesPort['addToolServer']>[0]) {
    return this.settings.addToolServer(req)
  },
  async connectMessaging(this: LivePortRuntime, platform: string) {
    return this.settings.connectMessaging(platform)
  },
  async messagingFields(this: LivePortRuntime, platform: string) {
    return messagingFields(platform)
  },
  async saveMessaging(this: LivePortRuntime, platform: string, req: MessagingSetupRequest) {
    const writes = messagingWrites(platform, req.values)
    let profile = this.options.settingsProfile
    if (req.agentId !== undefined) {
      const parsed = ProfileNameSchema.safeParse(req.agentId)
      if (!parsed.success || !this.profiles.profileHome(parsed.data))
        throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
      profile = parsed.data
    }
    return saveMessagingValues({
      hermesHome: resolveHermesHome(this.options.hermesHome),
      profile,
      platform,
      writes,
      runner: this.options.runner,
      locks: this.locks,
      invalidate: () => profile && this.profiles.invalidate(profile),
    })
  },
  testedBuilds(this: LivePortRuntime): TestedFingerprint[] {
    return [...(this.options.testedFingerprints ?? testedFingerprints), ...this.accepted.tested()]
  },
  async runHermesCheck(
    this: LivePortRuntime,
  ): Promise<HermesCheckResult & { fingerprint: Fingerprint }> {
    const home = resolveHermesHome(this.options.hermesHome)
    const fingerprint = await computeFingerprint({
      hermesHome: home,
      ...(this.gateway ? { gateway: this.gateway } : {}),
      ...(this.options.readCliVersion ? { readCliVersion: this.options.readCliVersion } : {}),
    })
    const facts = await (this.options.readSourceFacts ?? readSourceFacts)(hermesSourceDir(home))
    const result = buildHermesCheck({
      fingerprint,
      facts,
      // Compared only with builds that were really checked (an override is no baseline).
      tested: [
        ...(this.options.testedFingerprints ?? testedFingerprints),
        ...this.accepted.baselines(),
      ],
      knownPatternKeys: [...KNOWN_PATTERN_KEYS, ...this.accepted.patternKeys()],
    })
    return { ...result, fingerprint }
  },
  async checkHermes(this: LivePortRuntime): Promise<HermesCheck> {
    return (await this.runHermesCheck()).check
  },
  async acceptHermes(
    this: LivePortRuntime,
    hash: string,
    options: { override?: boolean } = {},
  ): Promise<void> {
    const { check, fingerprint, addedPatternKeys } = await this.runHermesCheck()
    if (check.hash !== hash)
      throw new HttpError(409, 'conflict', 'Hermes changed since it was checked. Check it again.')
    if (!check.compatible && !(options.override && check.overridable))
      throw new HttpError(
        409,
        options.override ? 'not_overridable' : 'not_compatible',
        options.override
          ? 'This Hermes build lacks what approvals need, so they can’t be turned on.'
          : 'This Hermes build changed in ways Score can’t accept.',
      )
    const overridden = check.compatible
      ? []
      : check.parts.filter((part) => part.status !== 'same').map((part) => part.name)
    this.accepted.add({
      id: fingerprint.id,
      parts: fingerprint.parts,
      testedAt: new Date().toISOString(),
      notes: overridden.length
        ? `Turned on anyway in Settings with the security password; differed: ${overridden.join(', ')}.`
        : 'Accepted in Settings after the Hermes version check.',
      addedPatternKeys,
      overridden,
    })
    this.fingerprint = fingerprint
    this.fingerprintAt = Date.now()
    await this.refresh
    await this.refreshStatus()
  },
  async searchConfig(this: LivePortRuntime, query: string) {
    return this.config.search(query)
  },
  async previewConfig(this: LivePortRuntime, changes: Parameters<HermesPort['previewConfig']>[0]) {
    return this.config.preview(changes)
  },
  async applyConfig(this: LivePortRuntime, req: Parameters<HermesPort['applyConfig']>[0]) {
    return this.config.apply(req)
  },
  agentHome(this: LivePortRuntime, agentId: string): string {
    const parsed = ProfileNameSchema.safeParse(agentId)
    const home = parsed.success ? this.profiles.profileHome(parsed.data) : null
    if (!home) throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    return home
  },
  async readAgentFile(
    this: LivePortRuntime,
    agentId: string,
    file: AgentFileName,
  ): Promise<AgentFile> {
    return this.profileFiles.read(this.agentHome(agentId), file)
  },
  async writeAgentFile(
    this: LivePortRuntime,
    agentId: string,
    file: AgentFileName,
    content: string,
    etag: string,
  ): Promise<{ etag: string }> {
    return this.profileFiles.write(this.agentHome(agentId), file, content, etag)
  },
}

export type SettingsMethods = typeof settingsMethods
