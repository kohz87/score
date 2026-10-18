import type { ThemeColorToken } from '@score/contract'
import type { Mode } from './draft.ts'
import type { Probe } from './frame-document.ts'

// Score's own look is written as CSS (tokens.css), not as a manifest, so the Customizer reads its values back from the
// browser: a hidden frame wearing the Score pack tells which value each public token has (what an unset colour shows).
// Every other built-in theme is a full package whose manifest "Start from" copies as it is (C4 #1).

// Not defined in tokens.css: the chat falls back to these.
const FALLBACKS: Partial<Record<ThemeColorToken, ThemeColorToken>> = {
  'bubble-own': 'ink',
  'bubble-own-ink': 'card',
}

/** Score's own value of a colour token in a mode ('' when the stylesheets don't say). */
export function defaultColor(probe: Probe, token: ThemeColorToken, mode: Mode): string {
  const direct = probe.read('score', mode, `--${token}`)
  const fallback = FALLBACKS[token]
  return direct || (fallback ? probe.read('score', mode, `--${fallback}`) : '')
}
