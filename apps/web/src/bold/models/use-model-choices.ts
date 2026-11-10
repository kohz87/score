import {
  CodingModelsResponseSchema,
  ModelSettingsSchema,
  ModelsResponseSchema,
  type AgentSummary,
} from '@score/contract'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { isCodingAgent, programGroup, programName } from './model-model.ts'

/** One row a chat's model can be set to: what to type after `/model`, and how it reads in a list. */
export type ModelChoice = { value: string; label: string; detail: string }

export type ModelChoices = {
  /** The agent's own model, as the header and "Back to its own" read it; undefined until it is known. */
  own: string | undefined
  coding: boolean
  program: string
  /** The coding agent's list heading, "CLAUDE CODE · your Claude plan". */
  programGroup: string
  /** An agent's aliases that match the search (Hermes agents only). */
  aliases: ModelChoice[]
  /** The models that match the search (a coding agent: its program's models). */
  models: ModelChoice[]
  /** True once the alias and model reads have answered or failed, so a menu can open on real rows. */
  ready: boolean
}

const matches = (query: string, ...texts: string[]) => {
  const word = query.trim().toLowerCase()
  return !word || texts.some((text) => text.toLowerCase().includes(word))
}

/**
 * What an agent's model can be set to in a chat, narrowed by `query` (null leaves the reads off). Hermes agents: their
 * aliases and the models Hermes lists for them. A coding agent: only its own program's models. These are the reads the
 * agent page's pickers make, so the caches are shared.
 */
export function useModelChoices(
  agent: AgentSummary | undefined,
  query: string | null,
): ModelChoices {
  const id = agent?.id ?? ''
  const coding = agent ? isCodingAgent(agent) : false
  const on = query !== null && Boolean(agent)
  const word = (query ?? '').trim()
  const settings = useQuery({
    queryKey: ['team', 'model-settings', id],
    enabled: on && !coding,
    retry: false,
    staleTime: 30_000,
    queryFn: async ({ signal }) =>
      ModelSettingsSchema.parse(
        await apiFetch(`agents/${encodeURIComponent(id)}/model-settings`, { signal }),
      ),
  })
  const listed = useQuery({
    queryKey: ['models', word, id, false],
    enabled: on && !coding,
    retry: false,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const params = new URLSearchParams()
      if (word) params.set('q', word)
      params.set('agentId', id)
      return ModelsResponseSchema.parse(await apiFetch(`models?${params.toString()}`))
    },
  })
  const runtime = agent?.runtime ?? ''
  const program = useQuery({
    queryKey: ['bold', 'coding-models', runtime],
    enabled: on && coding,
    retry: false,
    staleTime: 60_000,
    queryFn: async ({ signal }) =>
      CodingModelsResponseSchema.parse(
        await apiFetch(`coding-agents/runtimes/${encodeURIComponent(runtime)}/models`, { signal }),
      ),
  })
  const own = agent?.model?.id
  const providers = new Map(
    (listed.data?.items ?? []).map((item) => [item.provider, item.providerLabel]),
  )
  const aliases: ModelChoice[] = coding
    ? []
    : (settings.data?.aliases ?? [])
        .filter((alias) => matches(word, alias.name, alias.model))
        .map((alias) => ({
          value: alias.name,
          label: alias.name,
          detail: [
            alias.model,
            alias.provider ? (providers.get(alias.provider) ?? alias.provider) : null,
          ]
            .filter(Boolean)
            .join(' · '),
        }))
  const models: ModelChoice[] = coding
    ? (program.data?.models ?? [])
        .filter((model) => matches(word, model.id, model.name))
        .map((model) => ({
          value: model.id,
          label: model.id,
          detail: model.id === own ? 'its own' : (model.description ?? model.name),
        }))
    : (listed.data?.items ?? [])
        .filter((item) => !item.alias && item.available)
        .map((item) => ({
          value: item.model,
          label: item.model,
          detail: [item.providerLabel, item.model === own ? 'its own' : item.free ? 'free' : null]
            .filter(Boolean)
            .join(' · '),
        }))
  const settled = (query: { isPending: boolean; fetchStatus: string }) =>
    !query.isPending || query.fetchStatus === 'idle'
  return {
    own,
    coding,
    program: programName(agent?.runtime),
    programGroup: programGroup(agent?.runtime),
    aliases,
    models,
    ready: on && (coding ? settled(program) : settled(settings) && settled(listed)),
  }
}
