import { useState } from 'react'
import {
  STT_PROVIDERS,
  TTS_PROVIDERS,
  type ModelSettings,
  type ModelSettingsUpdate,
} from '@score/contract'
import { tabFailure } from '../../routes/team/tab-errors.ts'
import { useUpdateModelSettings } from '../../routes/team/model-settings-queries.ts'
import './model-settings.css'

export interface Draft {
  sttProvider: string
  sttModel: string
  ttsProvider: string
  ttsModel: string
  ttsVoice: string
}
const draftOf = (settings: ModelSettings): Draft => ({
  sttProvider: settings.speech.stt.provider ?? '',
  sttModel: settings.speech.stt.model ?? '',
  ttsProvider: settings.speech.tts.provider ?? '',
  ttsModel: settings.speech.tts.model ?? '',
  ttsVoice: settings.speech.tts.voice ?? '',
})

/** Only the fields that differ from what Hermes holds; a field of a just-switched provider counts when filled in. */
export function speechChanges(
  settings: ModelSettings,
  draft: Draft,
): ModelSettingsUpdate['speech'] | null {
  const before = draftOf(settings)
  const switchedStt = draft.sttProvider !== before.sttProvider
  const switchedTts = draft.ttsProvider !== before.ttsProvider
  const stt: NonNullable<NonNullable<ModelSettingsUpdate['speech']>['stt']> = {}
  const tts: NonNullable<NonNullable<ModelSettingsUpdate['speech']>['tts']> = {}
  const sttInfo = STT_PROVIDERS.find((item) => item.id === draft.sttProvider)
  const ttsInfo = TTS_PROVIDERS.find((item) => item.id === draft.ttsProvider)
  if (sttInfo && switchedStt) stt.provider = sttInfo.id
  // Automatic: Hermes picks the speech-to-text provider again.
  else if (switchedStt && draft.sttProvider === '') stt.provider = null
  // A value is compared with the previous provider's only when the provider stays: after a switch the destination
  // keeps its own model and voice, so a filled field is always sent (the server skips what it already holds).
  if (
    sttInfo?.model &&
    draft.sttModel.trim() &&
    (switchedStt || draft.sttModel.trim() !== before.sttModel)
  )
    stt.model = draft.sttModel.trim()
  if (ttsInfo && switchedTts) tts.provider = ttsInfo.id
  if (
    ttsInfo?.model &&
    draft.ttsModel.trim() &&
    (switchedTts || draft.ttsModel.trim() !== before.ttsModel)
  )
    tts.model = draft.ttsModel.trim()
  if (
    ttsInfo?.voice &&
    draft.ttsVoice.trim() &&
    (switchedTts || draft.ttsVoice.trim() !== before.ttsVoice)
  )
    tts.voice = draft.ttsVoice.trim()
  const speech = {
    ...(Object.keys(stt).length ? { stt } : {}),
    ...(Object.keys(tts).length ? { tts } : {}),
  }
  return Object.keys(speech).length ? speech : null
}

/** Team › agent › Model: speech-to-text and text-to-speech provider, model and voice. */
export function SpeechModels({ agentId, settings }: { agentId: string; settings: ModelSettings }) {
  const update = useUpdateModelSettings(agentId)
  const [draft, setDraft] = useState<Draft>(() => draftOf(settings))
  const change = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }))
  const sttInfo = STT_PROVIDERS.find((item) => item.id === draft.sttProvider)
  const ttsInfo = TTS_PROVIDERS.find((item) => item.id === draft.ttsProvider)
  const speech = speechChanges(settings, draft)

  return (
    <form
      className="ms-block"
      aria-labelledby="ms-speech-heading"
      onSubmit={(event) => {
        event.preventDefault()
        if (speech) update.mutate({ speech })
      }}
    >
      <h3 id="ms-speech-heading">Speech models</h3>
      <p className="ms-note">
        For voice messages sent to this agent and for reading replies aloud. Leave a model or voice
        empty to keep what Hermes uses.
      </p>
      <div className="ms-grid">
        <label className="ms-field">
          Speech to text
          <select
            value={draft.sttProvider}
            onChange={(e) => change({ sttProvider: e.target.value, sttModel: '' })}
          >
            <option value="">Automatic</option>
            {STT_PROVIDERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="ms-field">
          Speech to text model
          <input
            value={draft.sttModel}
            disabled={!sttInfo?.model}
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            placeholder={sttInfo?.model ? 'Provider default' : ''}
            onChange={(e) => change({ sttModel: e.target.value })}
          />
        </label>
      </div>
      <div className="ms-grid">
        <label className="ms-field">
          Text to speech
          <select
            value={draft.ttsProvider}
            onChange={(e) => change({ ttsProvider: e.target.value, ttsModel: '', ttsVoice: '' })}
          >
            {draft.ttsProvider === '' && <option value="">Not set</option>}
            {TTS_PROVIDERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="ms-field">
          Text to speech model
          <input
            value={draft.ttsModel}
            disabled={!ttsInfo?.model}
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            placeholder={ttsInfo?.model ? 'Provider default' : ''}
            onChange={(e) => change({ ttsModel: e.target.value })}
          />
        </label>
        <label className="ms-field">
          Voice
          <input
            value={draft.ttsVoice}
            disabled={!ttsInfo?.voice}
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            placeholder={ttsInfo?.voice ? 'Provider default' : ''}
            onChange={(e) => change({ ttsVoice: e.target.value })}
          />
        </label>
      </div>
      <div className="ms-actions">
        <button
          type="submit"
          className="ms-button"
          data-primary=""
          disabled={!speech || update.isPending}
        >
          {update.isPending ? 'Saving…' : 'Save speech models'}
        </button>
      </div>
      {update.isError && <p role="alert">{tabFailure(update.error, 'save the speech models')}</p>}
    </form>
  )
}
