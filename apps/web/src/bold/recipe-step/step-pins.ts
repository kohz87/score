import type { PinnedModel } from '@score/contract'
import type { Draft } from '../../routes/workflows/workflow-model.ts'

/** What a step's Model choice stands for in a `<select>`: an alias is its name (no provider), a model its provider too. */
export const pinValue = (pin: PinnedModel | undefined): string =>
  pin ? `${pin.provider ?? ''}\u0000${pin.model}` : ''

export const pinFromValue = (value: string): PinnedModel | undefined => {
  if (value === '') return undefined
  const [provider = '', model = ''] = value.split('\u0000')
  return { model, provider: provider === '' ? null : provider }
}

/**
 * Sets (or, with `undefined`, clears) one agent step's model and effort in the definition. A cleared one is removed, not
 * left as `undefined`: absent means "its own" and a saved definition has no empty keys.
 */
export function setStepPin(
  draft: Draft,
  nodeId: string,
  change: { model?: PinnedModel | undefined; effort?: string | undefined },
): Draft {
  return {
    ...draft,
    nodes: draft.nodes.map((node) => {
      if (node.id !== nodeId || node.kind !== 'agent') return node
      const next = { ...node }
      if ('model' in change) {
        if (change.model) next.model = change.model
        else delete next.model
      }
      if ('effort' in change) {
        if (change.effort) next.effort = change.effort
        else delete next.effort
      }
      return next
    }),
  }
}
