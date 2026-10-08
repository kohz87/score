import type { ModelOption } from '@score/contract'
import { filterModels } from '../model-options.ts'
import type { GatewayClient } from './gateway.ts'
import { providerLabel } from './settings.ts'

const CACHE_MS = 30_000
type Providers = Awaited<ReturnType<GatewayClient['modelOptions']>>['providers']

/** Model choices of the connected providers, from Hermes's own model options (cached briefly). */
export class LiveModels {
  private cached: { at: number; items: ModelOption[] } | undefined
  constructor(
    private readonly providers: () => Promise<Providers | null>,
    private readonly now: () => number = Date.now,
  ) {}

  async list(q?: string): Promise<ModelOption[]> {
    if (!this.cached || this.now() - this.cached.at > CACHE_MS) {
      try {
        const providers = await this.providers()
        if (!providers) return []
        this.cached = { at: this.now(), items: flatten(providers) }
      } catch {
        // Gateway unreachable: an empty list; the picker says the models couldn't be loaded.
        return []
      }
    }
    return filterModels(this.cached.items, q)
  }
}

function flatten(providers: Providers): ModelOption[] {
  const items: ModelOption[] = []
  for (const provider of providers) {
    if (provider.authenticated !== true || !provider.models?.length) continue
    const label = providerLabel(provider.slug, provider.name)
    const unavailable = new Set(provider.unavailable_models ?? [])
    for (const model of new Set(provider.models)) {
      const pricing = provider.pricing?.[model]
      const input = typeof pricing?.input === 'string' ? pricing.input : null
      const output = typeof pricing?.output === 'string' ? pricing.output : null
      const available = !unavailable.has(model)
      items.push({
        provider: provider.slug,
        providerLabel: label,
        model,
        available,
        reason: available ? null : 'Not on your plan',
        free: pricing?.free === true || model.endsWith(':free'),
        price: input !== null && output !== null ? { input, output } : null,
      })
    }
  }
  return items
}
