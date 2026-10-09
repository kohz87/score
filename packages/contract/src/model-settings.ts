import { z } from 'zod'

// Contract §8 (Team › agent › Model) and §10 (Settings › Models and keys): fallback chain, aliases, speech models and
// the Score-side list of models the pickers show. Names travel as CLI arguments, so no leading dash and no NUL.
const Name = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+#-]{0,199}$/)
  .refine((value) => !value.includes('\0'))

export const ModelRefSchema = z.object({ provider: Name, model: Name }).strict()
export type ModelRef = z.infer<typeof ModelRefSchema>

export const AliasNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)
export const ModelAliasSchema = z.object({
  name: AliasNameSchema,
  model: Name,
  provider: Name.nullable(),
  /** false for an alias with extra settings (endpoint, key) that Score would drop when rewriting it. */
  editable: z.boolean(),
})
export type ModelAlias = z.infer<typeof ModelAliasSchema>
export const AliasInputSchema = z
  .object({ name: AliasNameSchema, model: Name, provider: Name.nullish() })
  .strict()
export type AliasInput = z.infer<typeof AliasInputSchema>

/** Speech providers Hermes supports, and which of the model and voice settings each one has. */
export const STT_PROVIDERS = [
  { id: 'local', label: 'Local (faster-whisper)', model: true },
  { id: 'groq', label: 'Groq', model: true },
  { id: 'openai', label: 'OpenAI', model: true },
  { id: 'mistral', label: 'Mistral', model: true },
  { id: 'elevenlabs', label: 'ElevenLabs', model: true },
  { id: 'deepinfra', label: 'DeepInfra', model: true },
] as const
export const TTS_PROVIDERS = [
  { id: 'edge', label: 'Edge (free)', model: false, voice: true },
  { id: 'elevenlabs', label: 'ElevenLabs', model: true, voice: true },
  { id: 'openai', label: 'OpenAI', model: true, voice: true },
  { id: 'gemini', label: 'Gemini', model: true, voice: true },
  { id: 'xai', label: 'xAI', model: false, voice: true },
  { id: 'mistral', label: 'Mistral', model: true, voice: true },
  { id: 'minimax', label: 'MiniMax', model: true, voice: true },
  { id: 'deepinfra', label: 'DeepInfra', model: true, voice: true },
  { id: 'kittentts', label: 'KittenTTS (local)', model: true, voice: true },
  { id: 'piper', label: 'Piper (local)', model: false, voice: true },
  { id: 'neutts', label: 'NeuTTS (local)', model: true, voice: false },
] as const
const SttProviderId = z.enum(STT_PROVIDERS.map((item) => item.id) as [string, ...string[]])
const TtsProviderId = z.enum(TTS_PROVIDERS.map((item) => item.id) as [string, ...string[]])

export const SpeechSettingsSchema = z.object({
  /** provider null = Hermes picks one itself (stt only). */
  stt: z.object({ provider: SttProviderId.nullable(), model: Name.nullable() }),
  tts: z.object({
    provider: TtsProviderId.nullable(),
    model: Name.nullable(),
    voice: Name.nullable(),
  }),
})
export type SpeechSettings = z.infer<typeof SpeechSettingsSchema>

export const ModelSettingsSchema = z.object({
  /** Ordered chain Hermes tries when the model is unavailable (`fallback_providers`; any length). */
  fallbacks: z.array(ModelRefSchema),
  /** false when an entry has settings beyond provider and model (custom endpoint, key): shown, not rewritten. */
  fallbacksEditable: z.boolean(),
  aliases: z.array(ModelAliasSchema).max(200),
  speech: SpeechSettingsSchema,
})
export type ModelSettings = z.infer<typeof ModelSettingsSchema>

/** Only what changed is sent; a key left out is left alone. `aliases` is the full list of editable aliases wanted. */
export const ModelSettingsUpdateSchema = z
  .object({
    fallbacks: z.array(ModelRefSchema).optional(),
    aliases: z.array(AliasInputSchema).max(200).optional(),
    speech: z
      .object({
        /** `provider: null` goes back to Automatic (`config unset stt.provider`). */
        stt: z.object({ provider: SttProviderId.nullable(), model: Name }).partial().strict(),
        tts: z
          .object({
            provider: TtsProviderId,
            model: Name,
            voice: Name,
          })
          .partial()
          .strict(),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict()
export type ModelSettingsUpdate = z.infer<typeof ModelSettingsUpdateSchema>

export const ModelVisibilitySchema = z.object({ items: z.array(ModelRefSchema).max(1000) })
export type ModelVisibility = z.infer<typeof ModelVisibilitySchema>
