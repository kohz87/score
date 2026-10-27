import { describe, expect, test } from 'vitest'
import type { ModelSettings } from '@score/contract'
import { speechChanges, type Draft } from './SpeechModels.tsx'

const settings: ModelSettings = {
  effort: null,
  fallbacks: [],
  fallbacksEditable: true,
  aliases: [],
  speech: {
    stt: { provider: 'groq', model: 'whisper-large-v3-turbo' },
    tts: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy' },
  },
}
const same: Draft = {
  sttProvider: 'groq',
  sttModel: 'whisper-large-v3-turbo',
  ttsProvider: 'openai',
  ttsModel: 'gpt-4o-mini-tts',
  ttsVoice: 'alloy',
}

describe('speechChanges (audit5-e)', () => {
  test('nothing changed, nothing sent', () => {
    expect(speechChanges(settings, same)).toBeNull()
  })
  test('a model or voice typed after a provider switch is sent even when it equals the old provider’s', () => {
    expect(
      speechChanges(settings, {
        ...same,
        sttProvider: 'openai',
        ttsProvider: 'elevenlabs',
        ttsVoice: 'alloy',
        ttsModel: 'gpt-4o-mini-tts',
      }),
    ).toEqual({
      stt: { provider: 'openai', model: 'whisper-large-v3-turbo' },
      tts: { provider: 'elevenlabs', model: 'gpt-4o-mini-tts', voice: 'alloy' },
    })
  })
  test('Automatic speech-to-text clears the provider', () => {
    expect(speechChanges(settings, { ...same, sttProvider: '', sttModel: '' })).toEqual({
      stt: { provider: null },
    })
  })
})
