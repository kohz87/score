import type { EditorView } from '@codemirror/view'

// ---- images ------------------------------------------------------------------------------------------------------

/** Inserts image Markdown at `pos` (default: the selection), each on its own paragraph. */
export function insertImages(view: EditorView, markdown: string[], pos?: number): void {
  if (markdown.length === 0) return
  const main = view.state.selection.main
  const from = pos ?? main.from
  const to = pos === undefined ? main.to : pos
  const text = markdown.join('\n\n')
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  })
  view.focus()
}
