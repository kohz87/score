import type { ThemeColorToken, ThemeManifest } from '@score/contract'
import { contrastRatio, over, parseColor, type Rgba } from '../color.ts'
import { failsProtectedContrast } from '../engine.ts'
import { lookForView } from '../layout.ts'
import { tokenLabel } from './token-info.ts'
import type { Mode } from './draft.ts'

// Contrast checks of the Customizer (PLAN 9.4), built on the same maths as the engine's protected-surface check
// (themes/color.ts). Two kinds: pairs of colour tokens, measured from the draft's values, and the text that is really
// on screen in the preview (measure.ts).

export type Finding = {
  id: string
  /** Where it was found: a colour mode, or a page of the preview. */
  where: string
  text: string
  /** The tokens to change, when the finding comes from a pair of colours. */
  tokens?: ThemeColorToken[]
}

type Pair = {
  text: ThemeColorToken
  background: ThemeColorToken
  /** 4.5 for text, 3 for lines and large text. */
  minimum: number
  what: string
}

const pairs: Pair[] = [
  { text: 'ink', background: 'card', minimum: 4.5, what: 'Main text on cards' },
  { text: 'ink-muted', background: 'card', minimum: 4.5, what: 'Secondary text on cards' },
  { text: 'muted', background: 'card', minimum: 4.5, what: 'Quiet text on cards' },
  { text: 'ink', background: 'ground', minimum: 4.5, what: 'Main text on the page background' },
  {
    text: 'ink-muted',
    background: 'ground',
    minimum: 4.5,
    what: 'Secondary text on the page background',
  },
  { text: 'muted', background: 'ground', minimum: 4.5, what: 'Quiet text on the page background' },
  { text: 'on-dark', background: 'ink', minimum: 4.5, what: 'Text on the main buttons' },
  { text: 'panel-ink', background: 'panel-card', minimum: 4.5, what: 'Text on approval panels' },
  { text: 'chat-text', background: 'chat-soft', minimum: 4.5, what: 'Text on message cards' },
  {
    text: 'bubble-own-ink',
    background: 'bubble-own',
    minimum: 4.5,
    what: 'Text in your message bubble',
  },
  { text: 'tasks-note', background: 'tasks-done', minimum: 4.5, what: 'Text on done tasks' },
  { text: 'ink', background: 'tasks-ground', minimum: 4.5, what: 'Text on the Tasks board' },
  { text: 'link-hover', background: 'card', minimum: 4.5, what: 'Links when pointed at' },
  {
    text: 'watch-text',
    background: 'watch-window',
    minimum: 4.5,
    what: 'Text in the Watch window',
  },
  { text: 'line-strong', background: 'card', minimum: 3, what: 'Strong lines on cards' },
  { text: 'flow-edge', background: 'flow-canvas', minimum: 3, what: 'Lines between steps in Flow' },
]

const FALLBACK: Partial<Record<ThemeColorToken, ThemeColorToken>> = {
  'bubble-own': 'ink',
  'bubble-own-ink': 'card',
}

export const modeName = (mode: Mode) => (mode === 'light' ? 'Light' : 'Dark')
export const ratioText = (ratio: number) => `${(Math.floor(ratio * 10) / 10).toFixed(1)}:1`

/**
 * The colour pairs of a draft that are too faint, for both modes. `defaults(token, mode)` gives Score's own value for a
 * token the draft doesn't set. Only pairs that involve a colour the draft changed are reported: Score's own pairs are
 * checked elsewhere (packs.contrast.test).
 */
export function colourFindings(
  manifest: ThemeManifest,
  defaults: (token: ThemeColorToken, mode: Mode) => string,
): Finding[] {
  const out: Finding[] = []
  for (const mode of ['light', 'dark'] as const) {
    const set = (manifest.colors?.[mode] ?? {}) as Partial<Record<ThemeColorToken, string>>
    const valueOf = (token: ThemeColorToken): string => {
      const fallback = FALLBACK[token]
      return (
        set[token] ?? (fallback ? (set[fallback] ?? defaults(token, mode)) : defaults(token, mode))
      )
    }
    for (const pair of pairs) {
      const touched = [
        pair.text,
        pair.background,
        FALLBACK[pair.text],
        FALLBACK[pair.background],
      ].some((token) => token && set[token] !== undefined)
      if (!touched) continue
      const text = parseColor(valueOf(pair.text))
      const background = parseColor(valueOf(pair.background))
      if (!text || !background) continue
      const ratio = contrastRatio(text, background)
      if (ratio >= pair.minimum) continue
      out.push({
        id: `pair:${mode}:${pair.text}:${pair.background}`,
        where: modeName(mode),
        text: `${pair.what} is hard to read (${ratioText(ratio)}; ${pair.minimum}:1 is the least that works). Change “${tokenLabel(pair.text)}” or “${tokenLabel(pair.background)}”.`,
        tokens: [pair.text, pair.background],
      })
    }
    if (failsProtectedContrast(manifest, mode))
      out.push({
        id: `protected:${mode}`,
        where: modeName(mode),
        text: 'Approval cards and security screens will use Score’s own colours, because the text colours here are too faint on them.',
      })
  }
  // The user view wears `views.user` over the theme: its colours are checked the same way.
  const user = lookForView(manifest, 'user')
  if (user !== manifest)
    for (const mode of ['light', 'dark'] as const)
      if (failsProtectedContrast(user, mode) && !failsProtectedContrast(manifest, mode))
        out.push({
          id: `protected-user:${mode}`,
          where: `${modeName(mode)}, user view`,
          text: 'In the chat-first view, approval cards will use Score’s own colours, because the text colours there are too faint.',
        })
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Text on a picture or glass

/** The contrast of text over several possible backgrounds: low-end of the spread, so one busy patch counts. */
export function worstRatio(text: Rgba, layers: Rgba[], bases: Rgba[]): number {
  if (bases.length === 0) return Number.POSITIVE_INFINITY
  const ratios = bases
    .map((base) => {
      const background = layers.reduceRight<Rgba>((under, layer) => over(layer, under), base)
      return contrastRatio(text, background)
    })
    .sort((a, b) => a - b)
  // The 20th percentile: a small bright spot behind a word is noise, a bright band behind half of it is not.
  return ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * 0.2))]!
}
