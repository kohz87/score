import { EditorSelection, type ChangeSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { blockNamed, calloutHeaderAbove, QUOTE, selectedLines } from './editor-command-context.ts'
import type { CalloutType } from './editor-command-types.ts'

// ---- blocks ------------------------------------------------------------------------------------------------------

/**
 * Puts a block of Markdown on its own lines (a blank line before and after) at the caret and returns the offset where
 * the block starts. The caret's line is replaced when it is empty, else the block goes after it.
 */
export function insertBlock(
  view: EditorView,
  block: string,
  select?: { from: number; to: number },
): number {
  const { doc } = view.state
  const line = doc.lineAt(view.state.selection.main.head)
  const empty = line.text.trim() === ''
  const from = empty ? line.from : line.to
  const to = empty ? line.to : line.to
  const before = empty
    ? line.number > 1 && doc.line(line.number - 1).text.trim() !== ''
      ? '\n'
      : ''
    : '\n\n'
  const next = line.number < doc.lines ? doc.line(line.number + 1) : null
  const after = next && next.text.trim() !== '' ? '\n\n' : next ? '' : '\n'
  const insert = before + block + (empty && !next ? '\n' : after)
  const start = from + before.length
  view.dispatch({
    changes: { from, to, insert },
    selection: select
      ? EditorSelection.range(start + select.from, start + select.to)
      : { anchor: start + block.length },
    scrollIntoView: true,
  })
  view.focus()
  return start
}

export function insertRule(view: EditorView): boolean {
  insertBlock(view, '---')
  return true
}

export function toggleCodeBlock(view: EditorView, language = ''): boolean {
  const state = view.state
  const fenced = blockNamed(state, state.selection.main.head, ['FencedCode'])
  if (fenced) {
    const first = state.doc.lineAt(fenced.from)
    const last = state.doc.lineAt(fenced.to)
    const closing = /^\s*(```|~~~)\s*$/.test(last.text) && last.number !== first.number
    const changes: ChangeSpec[] = [
      { from: first.from, to: Math.min(first.to + 1, state.doc.length) },
    ]
    if (closing) changes.push({ from: Math.max(last.from - 1, first.to), to: last.to })
    view.dispatch({ changes, scrollIntoView: true })
    view.focus()
    return true
  }
  const main = state.selection.main
  if (!main.empty) {
    const startLine = state.doc.lineAt(main.from)
    const endLine = state.doc.lineAt(main.to)
    const from = startLine.from
    const to = endLine.to
    const body = state.sliceDoc(from, to)
    view.dispatch({
      changes: { from, to, insert: `\`\`\`${language}\n${body}\n\`\`\`` },
      selection: { anchor: from + 3 + language.length + 1 + body.length },
      scrollIntoView: true,
    })
    view.focus()
    return true
  }
  const open = `\`\`\`${language}\n`
  insertBlock(view, `${open}\n\`\`\``, { from: open.length, to: open.length })
  return true
}

export function setCallout(view: EditorView, type: CalloutType): boolean {
  const state = view.state
  const head = state.doc.lineAt(state.selection.main.head)
  const header = calloutHeaderAbove(state, head.number)
  if (header !== null) {
    const line = state.doc.line(header)
    view.dispatch({
      changes: {
        from: line.from,
        to: line.to,
        insert: line.text.replace(/\[![A-Za-z]+\]/, `[!${type}]`),
      },
    })
    view.focus()
    return true
  }
  const lines = selectedLines(state).filter((line) => line.text.trim() !== '')
  if (lines.length === 0) {
    const label = `> [!${type}] ${type[0]!.toUpperCase()}${type.slice(1)}\n> `
    insertBlock(view, label.replace(/\n> $/, '\n> '), {
      from: label.length,
      to: label.length,
    })
    return true
  }
  const first = lines[0]!
  const last = lines.at(-1)!
  view.dispatch({
    changes: {
      from: first.from,
      to: last.to,
      insert: `> [!${type}]\n${lines.map((line) => `> ${line.text.replace(QUOTE, '')}`).join('\n')}`,
    },
    scrollIntoView: true,
  })
  view.focus()
  return true
}
