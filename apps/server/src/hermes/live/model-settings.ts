import {
  AliasNameSchema,
  ModelRefSchema,
  STT_PROVIDERS,
  TTS_PROVIDERS,
  type AliasInput,
  type ModelAlias,
  type ModelRef,
  type ModelSettings,
  type ModelSettingsUpdate,
} from '@score/contract'
import { HttpError } from '../../errors.ts'
import { configJson } from './agent-config.ts'
import type { HermesRunner } from './cli.ts'

// Per-profile model settings that Hermes keeps in config.yaml (hermes_cli/config_defaults.py, fallback_config.py,
// model_switch.py). Score never opens the file: it asks `config get --json` for four sections, keeps the few fields
// it shows, and writes single keys with `config set` / `config unset`.
const KEYS = ['fallback_providers', 'model_aliases', 'tts', 'stt'] as const
export interface RawSettings {
  fallback_providers: unknown
  model_aliases: unknown
  tts: unknown
  stt: unknown
}
export type Op = { kind: 'set'; key: string; value: string } | { kind: 'unset'; key: string }

const Name = ModelRefSchema.shape.model
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const sameKeys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key))

/** Reads the four sections; throws a 502 when Hermes can't answer (a never-set section is just empty). */
export async function readRawSettings(
  runner: HermesRunner,
  hermesHome: string,
  profile: string,
): Promise<RawSettings> {
  const reads = await Promise.all(KEYS.map((key) => configJson(runner, hermesHome, profile, key)))
  const raw: Record<string, unknown> = {}
  KEYS.forEach((key, index) => {
    const read = reads[index]!
    if (read.state === 'unavailable')
      throw new HttpError(502, 'hermes_unavailable', 'Hermes could not be read')
    raw[key] = read.state === 'ok' ? read.value : undefined
  })
  return raw as unknown as RawSettings
}

function chainOf(raw: unknown): { entries: ModelRef[]; editable: boolean } {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? [raw] : []
  const entries: ModelRef[] = []
  let editable = raw === undefined || raw === null || Array.isArray(raw) || isRecord(raw)
  for (const item of list) {
    const parsed = isRecord(item) ? ModelRefSchema.safeParse(item) : undefined
    if (parsed?.success) entries.push(parsed.data)
    else if (
      isRecord(item) &&
      ModelRefSchema.safeParse({ provider: item.provider, model: item.model }).success
    ) {
      // Extra settings (endpoint, key) that a rewrite would drop.
      entries.push({ provider: String(item.provider), model: String(item.model) })
      editable = false
    } else editable = false
  }
  return { entries, editable }
}

function aliasesOf(raw: unknown): ModelAlias[] {
  if (!isRecord(raw)) return []
  const out: ModelAlias[] = []
  for (const [name, entry] of Object.entries(raw)) {
    if (!AliasNameSchema.safeParse(name).success || !isRecord(entry)) continue
    const model = Name.safeParse(entry.model)
    if (!model.success) continue
    const provider = Name.safeParse(entry.provider)
    out.push({
      name,
      model: model.data,
      provider: provider.success ? provider.data : null,
      editable: sameKeys(entry, ['model', 'provider']),
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// Hermes spells the model and voice keys differently per speech provider.
const ttsModelKey = (provider: string) => (provider === 'elevenlabs' ? 'model_id' : 'model')
const ttsVoiceKey = (provider: string) =>
  ['elevenlabs', 'xai', 'mistral', 'minimax'].includes(provider) ? 'voice_id' : 'voice'
const sttModelKey = (provider: string) => (provider === 'elevenlabs' ? 'model_id' : 'model')

function leaf(section: Record<string, unknown>, provider: string | null, key: string) {
  if (!provider) return null
  const group = section[provider]
  const parsed = isRecord(group) ? Name.safeParse(group[key]) : undefined
  return parsed?.success ? parsed.data : null
}
function providerOf(section: Record<string, unknown>, ids: readonly { id: string }[]) {
  return ids.find((item) => item.id === section.provider)?.id ?? null
}

export function deriveSettings(raw: RawSettings): ModelSettings {
  const chain = chainOf(raw.fallback_providers)
  const tts = isRecord(raw.tts) ? raw.tts : {}
  const stt = isRecord(raw.stt) ? raw.stt : {}
  const ttsProvider = providerOf(tts, TTS_PROVIDERS)
  const sttProvider = providerOf(stt, STT_PROVIDERS)
  const ttsInfo = TTS_PROVIDERS.find((item) => item.id === ttsProvider)
  const sttInfo = STT_PROVIDERS.find((item) => item.id === sttProvider)
  return {
    fallbacks: chain.entries,
    fallbacksEditable: chain.editable,
    aliases: aliasesOf(raw.model_aliases),
    speech: {
      stt: {
        provider: sttProvider as ModelSettings['speech']['stt']['provider'],
        model:
          sttInfo?.model && sttProvider ? leaf(stt, sttProvider, sttModelKey(sttProvider)) : null,
      },
      tts: {
        provider: ttsProvider as ModelSettings['speech']['tts']['provider'],
        model:
          ttsInfo?.model && ttsProvider ? leaf(tts, ttsProvider, ttsModelKey(ttsProvider)) : null,
        voice:
          ttsInfo?.voice && ttsProvider ? leaf(tts, ttsProvider, ttsVoiceKey(ttsProvider)) : null,
      },
    },
  }
}

const conflict = (message: string) => new HttpError(409, 'conflict', message)
const sameRef = (a: ModelRef, b: ModelRef) => a.provider === b.provider && a.model === b.model

/** The writes that turn `prior` into `update`: only keys whose value changed. */
export function planWrites(raw: RawSettings, update: ModelSettingsUpdate): Op[] {
  const prior = deriveSettings(raw)
  const tts = isRecord(raw.tts) ? raw.tts : {}
  const stt = isRecord(raw.stt) ? raw.stt : {}
  const ops: Op[] = []
  if (update.fallbacks) {
    const same =
      update.fallbacks.length === prior.fallbacks.length &&
      update.fallbacks.every((ref, index) => sameRef(ref, prior.fallbacks[index]!))
    if (!same) {
      if (!prior.fallbacksEditable)
        throw conflict('This fallback chain has custom endpoints; change it in Hermes directly')
      ops.push({ kind: 'set', key: 'fallback_providers', value: JSON.stringify(update.fallbacks) })
    }
  }
  if (update.aliases) ops.push(...aliasWrites(prior.aliases, update.aliases))
  const speech = update.speech
  if (speech?.stt) {
    const { provider, model } = speech.stt
    const next = provider ?? prior.speech.stt.provider
    if (provider && provider !== prior.speech.stt.provider)
      ops.push({ kind: 'set', key: 'stt.provider', value: provider })
    if (model !== undefined && model !== leaf(stt, next, sttModelKey(next ?? ''))) {
      if (!next || !STT_PROVIDERS.find((item) => item.id === next)?.model)
        throw conflict('Choose a speech-to-text provider with a model setting first')
      ops.push({ kind: 'set', key: `stt.${next}.${sttModelKey(next)}`, value: model })
    }
  }
  if (speech?.tts) {
    const { provider, model, voice } = speech.tts
    const next = provider ?? prior.speech.tts.provider
    const info = TTS_PROVIDERS.find((item) => item.id === next)
    if (provider && provider !== prior.speech.tts.provider)
      ops.push({ kind: 'set', key: 'tts.provider', value: provider })
    if (model !== undefined && model !== leaf(tts, next, ttsModelKey(next ?? ''))) {
      if (!next || !info?.model) throw conflict('That text-to-speech provider has no model setting')
      ops.push({ kind: 'set', key: `tts.${next}.${ttsModelKey(next)}`, value: model })
    }
    if (voice !== undefined && voice !== leaf(tts, next, ttsVoiceKey(next ?? ''))) {
      if (!next || !info?.voice) throw conflict('That text-to-speech provider has no voice setting')
      ops.push({ kind: 'set', key: `tts.${next}.${ttsVoiceKey(next)}`, value: voice })
    }
  }
  return ops
}

function aliasWrites(prior: ModelAlias[], wanted: AliasInput[]): Op[] {
  const ops: Op[] = []
  const names = new Set<string>()
  for (const alias of wanted) {
    if (names.has(alias.name)) throw conflict(`Alias ${alias.name} is listed twice`)
    names.add(alias.name)
    const before = prior.find((item) => item.name === alias.name)
    if (before && !before.editable)
      throw conflict(`Alias ${alias.name} has custom settings; change it in Hermes directly`)
    const provider = alias.provider ?? null
    if (before && before.model === alias.model && before.provider === provider) continue
    ops.push({
      kind: 'set',
      key: `model_aliases.${alias.name}`,
      value: JSON.stringify({ model: alias.model, ...(provider ? { provider } : {}) }),
    })
  }
  for (const before of prior)
    if (!names.has(before.name) && before.editable)
      ops.push({ kind: 'unset', key: `model_aliases.${before.name}` })
  return ops
}

/** `raw` with the writes applied, so a save answers from what it wrote without another round of Hermes reads. */
export function applyOps(raw: RawSettings, ops: Op[]): RawSettings {
  const next = structuredClone(raw) as unknown as Record<string, unknown>
  for (const op of ops) {
    const path = op.key.split('.')
    let node = next
    for (const part of path.slice(0, -1)) {
      const child = node[part]
      node = isRecord(child) ? child : ((node[part] = {}) as Record<string, unknown>)
    }
    const last = path.at(-1)!
    if (op.kind === 'unset') delete node[last]
    else
      node[last] =
        op.key === 'fallback_providers' || op.key.startsWith('model_aliases.')
          ? (JSON.parse(op.value) as unknown)
          : op.value
  }
  return next as unknown as RawSettings
}

/** "gpt-x, then claude-y": the agent card's "falls back to" text. */
export function fallbackText(fallbacks: ModelRef[]): string | null {
  return fallbacks.length ? fallbacks.map((ref) => ref.model).join(', then ') : null
}

/** Command-line arguments (after `-p <profile>`) for one write. */
export function opArgs(op: Op): string[] {
  return op.kind === 'set' ? ['config', 'set', op.key, op.value] : ['config', 'unset', op.key]
}
