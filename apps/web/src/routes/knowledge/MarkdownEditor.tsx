import { autocompletion, type CompletionContext } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import type { KnowledgeNoteSummary } from '@score/contract'
import { baseName, linkTargetFor } from './knowledge-paths.ts'

type Props = {
  initial: string
  label: string
  /** Latest note list for `[[` completion; read on every completion, so it may change without a remount. */
  notes: () => KnowledgeNoteSummary[]
  onChange: (text: string) => void
}

// Score look: JetBrains Mono on the card, tokens from tokens.css (so dark mode follows).
const scoreTheme = EditorView.theme({
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

// The default style's tags with every colour swapped for a themed token (it has light and dark values), so the editor
// follows Settings › Look. Reusing its specs avoids a direct dependency on @lezer/highlight just for the tag list.
const scoreHighlight = HighlightStyle.define(
  defaultHighlightStyle.specs.map((spec) => ({
    ...spec,
    ...('color' in spec ? { color: 'var(--agent-violet-text)' } : {}),
  })),
)

// Wikilink autocomplete after `[[` (adapted from the behaviour of the owner's Artemis editor; code written for Score).
export function wikilinkCompletion(notes: () => KnowledgeNoteSummary[]) {
  return (context: CompletionContext) => {
    const match = context.matchBefore(/\[\[[^\]\n]*/)
    if (!match) return null
    const query = match.text.slice(2).toLowerCase()
    const all = notes()
    const options = all
      .filter(
        (note) =>
          query === '' ||
          note.title.toLowerCase().includes(query) ||
          note.path.toLowerCase().includes(query),
      )
      .slice(0, 30)
      .map((note) => {
        const target = linkTargetFor(note, all)
        const after = context.state.doc.sliceString(context.pos, context.pos + 2)
        return {
          label: note.title || baseName(note.path),
          detail: note.path,
          apply: `${target}${after === ']]' ? '' : ']]'}`,
          type: 'text',
        }
      })
    return { from: match.from + 2, options, filter: false }
  }
}

export function MarkdownEditor({ initial, label, notes, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef({ notes, onChange })
  useEffect(() => {
    latest.current = { notes, onChange }
  })
  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initial,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          syntaxHighlighting(scoreHighlight),
          EditorView.lineWrapping,
          placeholder('Write in Markdown. Type [[ to link another note.'),
          autocompletion({
            override: [wikilinkCompletion(() => latest.current.notes())],
            icons: false,
          }),
          EditorView.contentAttributes.of({
            'aria-label': label,
            'aria-multiline': 'true',
            role: 'textbox',
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString())
          }),
          scoreTheme,
        ],
      }),
    })
    return () => view.destroy()
    // The editor is remounted (key) when a different text must be loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div ref={host} className="kn-editor-host" />
}
