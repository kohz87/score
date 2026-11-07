import { useRef, type Dispatch, type SetStateAction } from 'react'
import { useVoiceInput } from './voice.ts'

export function useComposerVoice({
  text,
  setText,
  setCaret,
  textarea,
}: {
  text: string
  setText: Dispatch<SetStateAction<string>>
  setCaret: Dispatch<SetStateAction<number>>
  textarea: { current: HTMLTextAreaElement | null }
}) {
  // Voice input: interim words replace each other in the draft until the utterance settles.
  const voiceBase = useRef('')
  const voice = useVoiceInput({
    onText: (heard) => {
      const base = voiceBase.current
      const next = heard ? `${base}${base && !/\s$/.test(base) ? ' ' : ''}${heard}` : base
      setText(next)
      setCaret(next.length)
    },
    onFinal: () => textarea.current?.focus(),
  })
  function toggleVoice() {
    if (voice.listening) voice.stop()
    else {
      voiceBase.current = text
      voice.start()
    }
  }
  return { voice, toggleVoice }
}
