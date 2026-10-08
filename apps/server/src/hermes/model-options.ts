import type { ModelOption } from '@score/contract'

export const MAX_MODEL_OPTIONS = 200

/** Case-insensitive; every space-separated term must appear in the model id or the provider label. */
export function filterModels(items: ModelOption[], q?: string): ModelOption[] {
  const terms = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return items
    .filter((item) => {
      const text = `${item.model} ${item.providerLabel}`.toLowerCase()
      return terms.every((term) => text.includes(term))
    })
    .sort(
      (a, b) =>
        Number(b.available) - Number(a.available) ||
        a.providerLabel.localeCompare(b.providerLabel) ||
        a.model.localeCompare(b.model),
    )
    .slice(0, MAX_MODEL_OPTIONS)
}
