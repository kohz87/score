import { autocompletion, type CompletionContext } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import type { KnowledgeNoteSummary } from '@score/contract'
import { scoreHighlight, scoreTheme } from '../../components/code-editor-theme.ts'
import { baseName, linkTargetFor } from './knowledge-paths.ts'

type Props = {
  initial: string
  label: string
  /** Latest note list for `[[` completion; read on every completion, so it may change without a remount. */
  notes: () => KnowledgeNoteSummary[]
  onChange: (text: string) => void
}

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
