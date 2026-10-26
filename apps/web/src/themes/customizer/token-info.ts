import type { ThemeColorToken } from '@score/contract'

// Plain-words names for the public colour tokens (design §3), grouped the way the Colours section shows them.

export type TokenInfo = { token: ThemeColorToken; label: string; hint: string }
export type TokenGroup = { id: string; label: string; tokens: TokenInfo[] }

const t = (token: ThemeColorToken, label: string, hint: string): TokenInfo => ({
  token,
  label,
  hint,
})

/**
 * What the Colours tab offers, in the new shell's areas (decision 131 E; docs/design/bold/README.md): the ground, the
 * panels and fields, text, the light objects that mean "for you or the result", lines, and the agent screen's code
 * ground. Only tokens the new shell reads are offered; a theme made earlier keeps the rest (Flow, Tasks, chat bubbles…)
 * untouched in its package, they just aren't edited here (`legacyGroups` still names them for the checks).
 */
export const tokenGroups: TokenGroup[] = [
  {
    id: 'ground',
    label: 'Ground and panels',
    tokens: [
      t('ground', 'Ground', 'Behind everything'),
      t('card', 'Panels', 'Room column, side panel, cards'),
      t('subtle', 'Fields and agent bubbles', 'Inputs, chips and replies'),
    ],
  },
  {
    id: 'text',
    label: 'Text',
    tokens: [
      t('ink', 'Text', 'Main text'),
      t('chat-secondary', 'Secondary text', 'Names, times and detail in a room'),
      t('ink-muted', 'Muted text', 'Captions and hints'),
      t('muted', 'Faint text', 'Labels and meta text'),
    ],
  },
  {
    id: 'for-you',
    label: 'For you and results',
    tokens: [
      t(
        'panel-card',
        'Requests, your messages, results',
        'Must stand out from the ground; colours too close to it are refused',
      ),
      t('panel-ink', 'Text on those', 'Text on requests, your messages and results'),
    ],
  },
  {
    id: 'lines',
    label: 'Lines',
    tokens: [t('hairline', 'Thin lines', 'Borders between things')],
  },
  {
    id: 'screen',
    label: 'Agent screen and code',
    tokens: [
      t('watch-stage', 'Terminal and code ground', 'Behind the terminal, editor and replay'),
      t('watch-text', 'Code text', 'Text on that ground'),
    ],
  },
]

/** Tokens the classic shell used (and the checks still name): not offered for editing any more. */
const legacyGroups: TokenGroup[] = [
  {
    id: 'legacy',
    label: 'Other',
    tokens: [
      t('line-strong', 'Strong lines', 'Outlines that must be seen'),
      t('subtle-2', 'Softer fill', 'Hover and nested areas'),
      t('track', 'Track', 'Empty part of bars and switches'),
      t('track-2', 'Darker track', 'Track edge and handles'),
      t('link-hover', 'Link hover', 'Links when pointed at'),
      t('on-dark', 'Text on dark fills', 'Text on coloured and dark panels'),
      t('chat-text', 'Message text', 'Replies in a room'),
      t('chat-soft', 'Message cards', 'Notes and tool cards'),
      t('chat-card-border', 'Message card border', 'Edge of those cards'),
      t('chat-dark-border', 'Dark card border', 'Edge of dark cards'),
      t('bubble-own', 'Your message bubble', 'Your messages when bubbles are on'),
      t('bubble-own-ink', 'Text in your bubble', 'Text on that bubble'),
      t('watch-window', 'Replay window', 'The window being replayed'),
    ],
  },
]

export const editableTokens: ThemeColorToken[] = tokenGroups.flatMap((group) =>
  group.tokens.map((item) => item.token),
)

export function tokenLabel(token: ThemeColorToken): string {
  for (const group of [...tokenGroups, ...legacyGroups]) {
    const found = group.tokens.find((item) => item.token === token)
    if (found) return found.label
  }
  return token
}
