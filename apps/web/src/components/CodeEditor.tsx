import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting } from '@codemirror/language'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { scoreHighlight, scoreTheme } from './code-editor-theme.ts'

/**
 * The language by file extension. Only the grammars already in the lockfile are used; everything else (Python, YAML,
 * shell, …) is plain text. JSON reuses the JavaScript grammar, which parses it.
 */
export function languageFor(path: string): Extension | null {
  const ext = /\.([^./]+)$/.exec(path.toLowerCase())?.[1] ?? ''
  if (['md', 'markdown', 'mdx'].includes(ext)) return markdown()
  if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) return javascript({ jsx: true })
  if (['ts', 'mts', 'cts'].includes(ext)) return javascript({ typescript: true })
  if (['tsx'].includes(ext)) return javascript({ typescript: true, jsx: true })
  if (ext === 'json') return javascript()
  if (ext === 'css') return css()
  if (['html', 'htm'].includes(ext)) return html()
  return null
}

type Props = {
  value: string
  /** Name of the file; picks the language. */
  path: string
  label: string
  onChange: (text: string) => void
  /** Ctrl/Cmd+S. */
  onSave?: () => void
}

/** CodeMirror 6 in the Score look, shared by Knowledge and Workspace. `value` is controlled from outside (reload, discard). */
export function CodeEditor({ value, path, label, onChange, onSave }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef({ onChange, onSave })
  useEffect(() => {
    latest.current = { onChange, onSave }
  })
  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const language = languageFor(path)
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                latest.current.onSave?.()
                return true
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          ...(language ? [language] : []),
          syntaxHighlighting(scoreHighlight),
          EditorView.lineWrapping,
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
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
    // One editor per file; the parent keys it by path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Text set from outside (Reload from disk, Discard, a follow of the file on disk).
  useEffect(() => {
    const editor = view.current
    if (editor && editor.state.doc.toString() !== value)
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } })
  }, [value])
  return <div ref={host} className="code-editor-host" />
}
