import { useCallback, useEffect, useRef, useState } from 'react'

// The Web Speech API is not in lib.dom; this is the slice we use.
type Alternative = { transcript: string }
type Result = { isFinal: boolean; 0: Alternative }
type RecognitionEvent = { resultIndex: number; results: ArrayLike<Result> }
export interface Recognizer {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: RecognitionEvent) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error?: string }) => void) | null
  start(): void
  stop(): void
  abort(): void
}
type RecognizerConstructor = new () => Recognizer

export const SILENCE_MS = 2000

export function recognizerConstructor(): RecognizerConstructor | null {
  const scope = globalThis as unknown as {
    SpeechRecognition?: RecognizerConstructor
    webkitSpeechRecognition?: RecognizerConstructor
  }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

/**
 * Voice input for the composer (PLAN 5.25). Interim words are shown as they arrive: `onText` gets the transcript of the
 * current utterance (replace what the previous call returned), and `onFinal` the settled text to keep. Listening stops after
 * ~2 s without speech. `supported` is false where the browser has no recognizer, and the button is then not shown.
 */
export function useVoiceInput({
  onText,
  onFinal,
}: {
  onText: (interim: string) => void
  onFinal: (text: string) => void
}) {
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recognizer = useRef<Recognizer | null>(null)
  const silence = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const handlers = useRef({ onText, onFinal })
  useEffect(() => {
    handlers.current = { onText, onFinal }
  })
  const supported = recognizerConstructor() !== null

  const stop = useCallback(() => {
    clearTimeout(silence.current)
    recognizer.current?.stop()
  }, [])
  useEffect(
    () => () => {
      clearTimeout(silence.current)
      recognizer.current?.abort()
    },
    [],
  )

  const start = useCallback(() => {
    const Recognition = recognizerConstructor()
    if (!Recognition || recognizer.current) return
    const instance = new Recognition()
    instance.continuous = true
    instance.interimResults = true
    instance.lang = globalThis.navigator?.language || 'en-US'
    const rearm = () => {
      clearTimeout(silence.current)
      silence.current = setTimeout(() => instance.stop(), SILENCE_MS)
    }
    let final = ''
    instance.onresult = (event) => {
      let interim = ''
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index]!
        if (result.isFinal) final += result[0].transcript
        else interim += result[0].transcript
      }
      handlers.current.onText((final + interim).trim())
      rearm()
    }
    instance.onerror = (event) => {
      if (event.error && event.error !== 'no-speech' && event.error !== 'aborted')
        setError(
          event.error === 'not-allowed'
            ? 'Microphone access was blocked.'
            : 'Voice input stopped working.',
        )
    }
    instance.onend = () => {
      clearTimeout(silence.current)
      recognizer.current = null
      setListening(false)
      handlers.current.onFinal(final.trim())
    }
    recognizer.current = instance
    setError(null)
    try {
      instance.start()
      setListening(true)
      rearm()
    } catch {
      recognizer.current = null
      setError('Voice input could not start.')
    }
  }, [])

  return { supported, listening, error, start, stop }
}
