import {
  type AgentFile,
  type AgentFileName,
  AgentFileConflictError,
  assertFileContent,
  etagOf,
} from '../agent-files.ts'
import type {
  ConnectResult,
  ConnectionsResponse,
  HermesCheck,
  LocalProviderRequest,
  MessagingFieldsResponse,
  MessagingPlatform,
  MessagingSetupRequest,
  ModelOption,
  ModelRef,
  SignIn,
  ToolServerRequest,
} from '@score/contract'
import { HttpError } from '../../errors.ts'
import { filterModels } from '../model-options.ts'
import { messagingFields, messagingWrites } from '../messaging-fields.ts'
import type { HermesPort, ProviderBase } from '../port.ts'
import { createFakeConfigService } from './fake-config.ts'
import { FakePortState } from './fake-port-state.ts'

export abstract class FakePortProviders extends FakePortState {
  protected readonly fakeProviders: ProviderBase[] = [
    {
      id: 'demo',
      label: 'Demo',
      status: 'connected',
      detail: 'Built-in demo models',
      signIn: 'terminal',
    },
    {
      id: 'openrouter',
      label: 'OpenRouter',
      status: 'missing',
      detail: 'Not connected',
      signIn: 'api_key',
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      status: 'needs_signin',
      detail: 'Session expired',
      signIn: 'terminal',
    },
    {
      id: 'openai-codex',
      label: 'ChatGPT (Codex)',
      status: 'connected',
      detail: 'Your ChatGPT plan',
      signIn: 'device_code',
    },
    {
      id: 'nous',
      label: 'Nous Portal',
      status: 'missing',
      detail: 'Not connected',
      signIn: 'device_code',
    },
  ]
  // Fake sign-ins finish on the third status read (the mount read plus two 2 s polls), so e2e is deterministic.
  protected readonly fakeSignIns = new Map<string, { signIn: SignIn; reads: number }>()
  protected readonly fakeModels: ModelOption[] = [
    ...['gpt-6.1-sol', 'gpt-6-luna'].map((model) => ({
      provider: 'openai-codex',
      providerLabel: 'ChatGPT (Codex)',
      model,
      available: true,
      reason: null,
      free: false,
      price: { input: '$2.00', output: '$10.00' },
      contextLength: 272000,
    })),
    {
      provider: 'nous',
      providerLabel: 'Nous Portal',
      model: 'openai/gpt-6.1-sol',
      available: false,
      reason: 'Not on your plan',
      free: false,
      price: { input: '$2.50', output: '$12.00' },
    },
    {
      provider: 'nous',
      providerLabel: 'Nous Portal',
      model: 'upstage/solar-mini4:free',
      available: true,
      reason: null,
      free: true,
      price: null,
    },
    {
      provider: 'local',
      providerLabel: 'Local server',
      model: 'local-gpt-mini',
      available: true,
      reason: null,
      free: true,
      price: null,
    },
    // The model the demo agents run on (the Chat context meter reads its window).
    {
      provider: 'local',
      providerLabel: 'Local server',
      model: 'fake-model',
      available: true,
      reason: null,
      free: true,
      price: null,
      contextLength: 128000,
    },
  ]
  async listModels(q?: string, only?: readonly ModelRef[], limit?: number): Promise<ModelOption[]> {
    return structuredClone(filterModels(this.fakeModels, q, only, limit))
  }
  async listProviders(): Promise<ProviderBase[]> {
    return structuredClone(this.fakeProviders)
  }
  async connectProvider(id: string): Promise<ConnectResult> {
    const provider = this.fakeProviders.find((candidate) => candidate.id === id)
    if (!provider) throw new HttpError(404, 'not_found', 'Couldn’t find that provider.')
    const command = `hermes auth add ${id}`
    if (provider.signIn !== 'device_code') return { next: 'run_in_terminal', command }
    let entry = [...this.fakeSignIns.values()].find(
      (candidate) => candidate.signIn.providerId === id && candidate.signIn.state === 'waiting',
    )
    if (!entry) {
      entry = {
        reads: 0,
        signIn: {
          id: `fake-${this.fakeSignIns.size + 1}`,
          providerId: id,
          state: 'waiting',
          url: 'https://example.com/device',
          code: 'WXYZ-1234',
          expiresAt: new Date(this.scheduler.now() + 15 * 60_000).toISOString(),
          message: null,
        },
      }
      this.fakeSignIns.set(entry.signIn.id, entry)
    }
    const { signIn } = entry
    return {
      next: 'device_code',
      command,
      url: signIn.url!,
      code: signIn.code!,
      signInId: signIn.id,
      expiresAt: signIn.expiresAt,
    }
  }
  protected fakeSignIn(id: string) {
    const entry = this.fakeSignIns.get(id)
    if (!entry) throw new HttpError(404, 'not_found', 'Couldn’t find that sign-in.')
    return entry
  }
  async getSignIn(id: string): Promise<SignIn> {
    const entry = this.fakeSignIn(id)
    if (entry.signIn.state === 'waiting' && ++entry.reads >= 3) {
      entry.signIn = { ...entry.signIn, state: 'connected', url: null, code: null }
      const provider = this.fakeProviders.find((p) => p.id === entry.signIn.providerId)
      if (provider) Object.assign(provider, { status: 'connected', detail: 'Signed in' })
    }
    return structuredClone(entry.signIn)
  }
  async cancelSignIn(id: string): Promise<SignIn> {
    const entry = this.fakeSignIn(id)
    if (entry.signIn.state === 'waiting')
      entry.signIn = { ...entry.signIn, state: 'cancelled', url: null, code: null }
    return structuredClone(entry.signIn)
  }
  async addProviderKey(id: string): Promise<ProviderBase> {
    const provider = this.fakeProviders.find((candidate) => candidate.id === id)
    if (!provider) throw new HttpError(404, 'not_found', 'Couldn’t find that provider.')
    // A local provider takes a key too (2.0.10); like the live adapter, the fake keeps no key.
    if (provider.keySet !== undefined) {
      provider.keySet = true
      return structuredClone(provider)
    }
    if (provider.signIn !== 'api_key')
      throw new HttpError(
        409,
        'not_supported',
        'This provider doesn’t take a pasted key. Use its sign-in instead.',
      )
    // The fake keeps no key, just like the live adapter.
    Object.assign(provider, { status: 'connected', detail: 'API key (1)' })
    return structuredClone(provider)
  }
  async addLocalProvider(req: LocalProviderRequest): Promise<ProviderBase> {
    const id = req.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (!id)
      throw new HttpError(
        400,
        'bad_request',
        'Couldn’t read that request. Check what you entered and try again.',
      )
    if (this.fakeProviders.some((provider) => provider.id === id))
      throw new HttpError(409, 'conflict', 'A provider with that name already exists.')
    const provider: ProviderBase = {
      id,
      label: req.label,
      status: 'connected',
      detail: new URL(req.baseUrl).host,
      keySet: req.apiKey !== undefined,
    }
    this.fakeProviders.push(provider)
    return structuredClone(provider)
  }
  async removeProvider(id: string): Promise<void> {
    const at = this.fakeProviders.findIndex((provider) => provider.id === id)
    if (at < 0) throw new HttpError(404, 'not_found', 'Couldn’t find that provider.')
    if (this.fakeProviders[at]!.status === 'missing')
      throw new HttpError(409, 'not_supported', 'Nothing is stored for this provider.')
    this.fakeProviders.splice(at, 1)
  }

  protected readonly fakeMessaging = new Set<string>()
  protected readonly fakeMessagingRemoved = new Set<string>()
  protected readonly fakeToolServersRemoved = new Set<string>()

  async removeToolServer(id: string): Promise<void> {
    const known = (await this.listConnections()).toolServers.some((server) => server.id === id)
    if (!known) throw new HttpError(404, 'not_found', 'Couldn’t find that tool server.')
    this.fakeToolServersRemoved.add(id)
  }
  async removeMessaging(platform: string): Promise<MessagingPlatform> {
    if (!messagingFields(platform).browserSetup)
      throw new HttpError(409, 'not_supported', 'Remove this one with `hermes gateway setup`.')
    this.fakeMessaging.delete(platform)
    this.fakeMessagingRemoved.add(platform)
    const row = (await this.listConnections()).messaging.find((item) => item.platform === platform)
    return row ?? { platform, label: platform, status: 'disconnected', detail: null }
  }
  async listConnections(): Promise<ConnectionsResponse> {
    return {
      toolServers: [
        { id: 'files', label: 'files', status: 'ok', usedBy: 'everyone' },
        { id: 'web-search', label: 'web-search', status: 'needs_signin', usedBy: 'everyone' },
        { id: 'issue-tracker', label: 'issue-tracker', status: 'error', usedBy: 'everyone' },
      ].filter(
        (server) => !this.fakeToolServersRemoved.has(server.id),
      ) as ConnectionsResponse['toolServers'],
      messaging: (
        [
          { platform: 'telegram', label: 'Telegram', status: 'connected', detail: null },
          { platform: 'discord', label: 'Discord', status: 'disconnected', detail: null },
          { platform: 'slack', label: 'Slack', status: 'disconnected', detail: 'auth_failed' },
        ] as MessagingPlatform[]
      ).map((row) =>
        this.fakeMessaging.has(row.platform)
          ? { ...row, status: 'connected' as const, detail: null }
          : this.fakeMessagingRemoved.has(row.platform)
            ? { ...row, status: 'disconnected' as const, detail: null }
            : row,
      ),
    }
  }
  async addToolServer(req: ToolServerRequest): Promise<ConnectResult> {
    return { next: 'run_in_terminal', command: `hermes mcp add ${req.name}` }
  }
  async connectMessaging(platform: string): Promise<ConnectResult> {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(platform))
      throw new HttpError(404, 'not_found', 'Couldn’t find that messaging platform.')
    if (messagingFields(platform).browserSetup) return { next: 'form' }
    return { next: 'run_in_terminal', command: 'hermes gateway setup' }
  }
  async messagingFields(platform: string): Promise<MessagingFieldsResponse> {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(platform))
      throw new HttpError(404, 'not_found', 'Couldn’t find that messaging platform.')
    return messagingFields(platform)
  }
  // Nothing is written in fake mode; the platform reads as connected afterwards so the UI path can be exercised.
  async saveMessaging(platform: string, req: MessagingSetupRequest): Promise<MessagingPlatform> {
    messagingWrites(platform, req.values)
    this.fakeMessaging.add(platform)
    this.fakeMessagingRemoved.delete(platform)
    const row = (await this.listConnections()).messaging.find((item) => item.platform === platform)
    return row ?? { platform, label: platform, status: 'connected', detail: null }
  }
  // The fake Hermes is always the tested build: a check is clean and accepting changes nothing.
  async checkHermes(): Promise<HermesCheck> {
    return {
      hash: '0'.repeat(64),
      build: { version: null, codeSha: null, fingerprint: 'fake' },
      parts: [{ name: 'Capabilities', status: 'same', detail: 'Fake adapter' }],
      compatible: true,
      overridable: false,
    }
  }
  async acceptHermes(): Promise<void> {}

  protected readonly config = createFakeConfigService()
  async searchConfig(query: string) {
    return this.config.search(query)
  }
  async previewConfig(changes: Parameters<HermesPort['previewConfig']>[0]) {
    return this.config.preview(changes)
  }
  async applyConfig(req: Parameters<HermesPort['applyConfig']>[0]) {
    return this.config.apply(req)
  }
  async readAgentFile(agentId: string, file: AgentFileName): Promise<AgentFile> {
    if (!this.agents.has(agentId))
      throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    const content = this.files.get(`${agentId}/${file}`) ?? ''
    return { content, etag: etagOf(content) }
  }

  async writeAgentFile(
    agentId: string,
    file: AgentFileName,
    content: string,
    etag: string,
  ): Promise<{ etag: string }> {
    assertFileContent(content)
    const current = await this.readAgentFile(agentId, file)
    if (current.etag !== etag) throw new AgentFileConflictError(current)
    this.files.set(`${agentId}/${file}`, content)
    return { etag: etagOf(content) }
  }
}
