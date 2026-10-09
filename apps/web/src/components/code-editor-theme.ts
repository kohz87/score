import { HighlightStyle } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

// Score look: JetBrains Mono on the card, tokens from tokens.css (so dark mode follows).
export const scoreTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--ink)', fontSize: '14px' },
  '.cm-content': {
    fontFamily: 'var(--font-code)',
    lineHeight: '1.65',
    caretColor: 'var(--ink)',
    padding: '4px 0',
  },
  '.cm-line': { padding: '0 2px' },
  '&.cm-focused': { outline: '2px solid var(--ink)', outlineOffset: '2px', borderRadius: '8px' },
  '.cm-cursor': { borderLeftColor: 'var(--ink)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--agent-violet-tint)',
  },
  '.cm-tooltip': {
    border: '1px solid var(--hairline)',
    borderRadius: '14px',
    backgroundColor: 'var(--card)',
    color: 'var(--ink)',
    overflow: 'hidden',
    fontFamily: 'var(--font-body)',
  },
  '.cm-tooltip-autocomplete ul li': { padding: '6px 12px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--ink)',
    color: 'var(--card)',
  },
  '.cm-completionDetail': { fontStyle: 'normal', opacity: '0.7', marginLeft: '8px' },
  '.cm-placeholder': { color: 'var(--muted)' },
})

// Colours are themed tokens (each has a light and a dark value), so the editor follows Settings › Look.
export const scoreHighlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--agent-violet-text)', fontWeight: '700' },
  { tag: [tags.link, tags.url], color: 'var(--agent-coral-text)', textDecoration: 'underline' },
  { tag: tags.monospace, color: 'var(--agent-jade-text)' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, color: 'var(--agent-saffron-text)', fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.quote, color: 'var(--ink-muted)', fontStyle: 'italic' },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: 'var(--muted)' },
  // Source code (Workspace editor): the same themed tokens, so dark mode follows.
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--agent-violet-text)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--agent-jade-text)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--agent-saffron-text)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: 'var(--muted)',
    fontStyle: 'italic',
  },
  { tag: [tags.function(tags.variableName), tags.propertyName], color: 'var(--agent-coral-text)' },
  { tag: [tags.typeName, tags.className, tags.tagName], color: 'var(--agent-coral-text)' },
])
