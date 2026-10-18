import { THEME_COLOR_TOKENS, type ThemeColorToken } from '@score/contract'

// Plain-words names for the public colour tokens (design §3), grouped the way the Colours section shows them. Every
// token of the contract list is here except the two halo sizes, which are lengths and not colours.

export type TokenInfo = { token: ThemeColorToken; label: string; hint: string }
export type TokenGroup = { id: string; label: string; tokens: TokenInfo[] }

const t = (token: ThemeColorToken, label: string, hint: string): TokenInfo => ({
  token,
  label,
  hint,
})

export const tokenGroups: TokenGroup[] = [
  {
    id: 'page',
    label: 'Page and cards',
    tokens: [
      t('ground', 'Page background', 'Behind everything'),
      t('card', 'Card background', 'Cards and panels'),
      t('ink', 'Main text', 'Text, and the main buttons'),
      t('ink-muted', 'Secondary text', 'Captions and hints'),
      t('muted', 'Quiet text', 'Labels and meta text'),
      t('hairline', 'Thin lines', 'Borders between things'),
      t('line-strong', 'Strong lines', 'Outlines that must be seen'),
      t('subtle', 'Soft fill', 'Chips and quiet areas'),
      t('subtle-2', 'Softer fill', 'Hover and nested areas'),
      t('track', 'Track', 'Empty part of bars and switches'),
      t('track-2', 'Darker track', 'Track edge and handles'),
      t('link-hover', 'Link hover', 'Links when pointed at'),
      t('on-dark', 'Text on dark fills', 'Text on the main buttons'),
    ],
  },
  {
    id: 'panels',
    label: 'Approval panels',
    tokens: [
      t('panel-card', 'Panel background', 'Approvals and command boxes'),
      t('panel-ink', 'Panel text', 'Text on those panels'),
    ],
  },
  {
    id: 'chat',
    label: 'Chat',
    tokens: [
      t('chat-text', 'Message text', 'Replies in a room'),
      t('chat-secondary', 'Message detail text', 'Names and times'),
      t('chat-soft', 'Message cards', 'Notes and tool cards'),
      t('chat-card-border', 'Message card border', 'Edge of those cards'),
      t('chat-dark-border', 'Dark card border', 'Edge of dark cards'),
      t('bubble-own', 'Your message bubble', 'Your messages when bubbles are on'),
      t('bubble-own-ink', 'Text in your bubble', 'Text on that bubble'),
    ],
  },
  {
    id: 'tasks',
    label: 'Tasks and Team',
    tokens: [
      t('tasks-ground', 'Tasks board', 'Behind the columns'),
      t('tasks-border', 'Tasks borders', 'Column and card edges'),
      t('tasks-done', 'Done tasks', 'Finished cards'),
      t('tasks-note', 'Task notes', 'Text of a note'),
      t('profile-dashed', 'Add-agent outline', 'Dashed outline of “Add agent”'),
      t('profile-add-ink', 'Add-agent text', 'Text inside it'),
    ],
  },
  {
    id: 'flow',
    label: 'Flow',
    tokens: [
      t('flow-canvas', 'Flow canvas', 'Behind the graph'),
      t('flow-canvas-dot', 'Canvas dots', 'The dot grid'),
      t('flow-edge', 'Flow lines', 'Lines between steps'),
      t('flow-edge-planned', 'Planned lines', 'Lines not taken yet'),
      t('flow-edge-sent-back', 'Sent-back lines', 'Work sent back'),
      t('flow-done-border', 'Finished step edge', 'Edge of a finished step'),
      t('flow-log-border', 'Log lines', 'Lines inside the log'),
    ],
  },
  {
    id: 'watch',
    label: 'Watch',
    tokens: [
      t('watch-stage', 'Watch stage', 'Behind the replay'),
      t('watch-window', 'Replay window', 'The window being replayed'),
      t('watch-text', 'Replay text', 'Text inside it'),
    ],
  },
]
export const editableTokens: ThemeColorToken[] = tokenGroups.flatMap((group) =>
  group.tokens.map((item) => item.token),
)

export function tokenLabel(token: ThemeColorToken): string {
  for (const group of tokenGroups) {
    const found = group.tokens.find((item) => item.token === token)
    if (found) return found.label
  }
  return token
}

// Every colour token of the contract is either offered or one of the two sizes.
export const notColours: readonly ThemeColorToken[] = THEME_COLOR_TOKENS.filter(
  (token) => !editableTokens.includes(token),
)
