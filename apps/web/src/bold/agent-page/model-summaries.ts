import type { AgentDetail, AgentSubagents, ModelSettings } from '@score/contract'
import { STT_PROVIDERS, TTS_PROVIDERS } from '@score/contract'

/** "Falls back to a, then b", or "No fallback"; the chain from Hermes' settings once read, else the one the page knows. */
export function fallbackSummary(agent: AgentDetail, settings: ModelSettings | undefined): string {
  const chain = settings?.fallbacks.map((ref) => ref.model) ?? []
  if (chain.length) return `Falls back to ${chain.join(', then ')}`
  if (agent.model?.fallback) return `Falls back to ${agent.model.fallback}`
  return 'No fallback'
}

export function aliasSummary(settings: ModelSettings | undefined): string {
  if (!settings) return 'Reading Hermes…'
  const names = settings.aliases.map((alias) => alias.name)
  if (!names.length) return 'No aliases yet'
  return `${names.length} · ${names.join(', ')} · used as /model ${names[0]}`
}

export function speechSummary(settings: ModelSettings | undefined): string {
  if (!settings) return 'Reading Hermes…'
  const { stt, tts } = settings.speech
  const label = (list: readonly { id: string; label: string }[], id: string | null) =>
    list.find((item) => item.id === id)?.label ?? id
  const hear = `Speech to text: ${stt.provider ? label(STT_PROVIDERS, stt.provider) : 'Automatic'}`
  const say = tts.provider
    ? `Reads aloud with ${label(TTS_PROVIDERS, tts.provider)}${tts.voice ? `, ${tts.voice}` : ''}`
    : 'Reads aloud: not set'
  return `${hear} · ${say}`
}

export function subagentsSummary(value: AgentSubagents | undefined): string {
  if (!value) return 'Reading Hermes…'
  if (value.control === 'none') return 'Not supported here yet'
  if (!value.enabled) return 'Off'
  if (value.control === 'on_off') return 'Allowed'
  const parts = ['Allowed', `up to ${value.maxConcurrent} at once`]
  if (value.maxIterations !== null) parts.push(`${value.maxIterations} steps each`)
  parts.push(value.model ? value.model : 'same model')
  return parts.join(' · ')
}
