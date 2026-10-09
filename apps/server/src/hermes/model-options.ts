import type { ModelOption, ModelRef } from '@score/contract'

export const MAX_MODEL_OPTIONS = 200

/** `only` (when non-empty) keeps just those provider/model pairs. Case-insensitive; every space-separated term must appear in the model id or the provider label. */
export function filterModels(
  items: ModelOption[],
  q?: string,
  only?: readonly ModelRef[],
): ModelOption[] {
  const chosen = only?.length
    ? new Set(only.map((ref) => `${ref.provider}\0${ref.model}`))
    : undefined
  const terms = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return items
    .filter((item) => !chosen || chosen.has(`${item.provider}\0${item.model}`))
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
