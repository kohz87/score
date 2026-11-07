import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { ancestorNamed } from './editor-command-context.ts'
import type { LinkTarget } from './editor-command-types.ts'

// ---- links -------------------------------------------------------------------------------------------------------

export function linkSelectionText(state: EditorState): string {
  const main = state.selection.main
  const link = ancestorNamed(state, main.head, ['Link'])
  if (link) {
    const marks = link.getChildren('LinkMark')
    if (marks.length >= 2) return state.sliceDoc(marks[0]!.to, marks[1]!.from)
  }
  return main.empty ? '' : state.sliceDoc(main.from, main.to).replace(/\n+/g, ' ')
}

/** Inserts `[text](url)` or `[[Note]]` (`[[Note|text]]` when the text differs) over the selection or the link at the caret. */
export function insertLink(view: EditorView, text: string, target: LinkTarget): boolean {
  const state = view.state
  const main = state.selection.main
  const link = ancestorNamed(state, main.head, ['Link'])
  const from = link ? link.from : main.from
  const to = link ? link.to : main.to
  const label = text.trim()
  const markdown =
    target.kind === 'web'
      ? `[${label || target.url}](${target.url.replace(/\)/g, '%29').replace(/\s/g, '%20')})`
      : label && label !== target.target
        ? `[[${target.target}|${label}]]`
        : `[[${target.target}]]`
  view.dispatch({
    changes: { from, to, insert: markdown },
    selection: { anchor: from + markdown.length },
    scrollIntoView: true,
  })
  view.focus()
  return true
}
