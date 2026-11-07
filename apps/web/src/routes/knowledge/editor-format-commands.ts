import { EditorSelection, type ChangeSpec, type EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import {
  ancestorNamed,
  blockNamed,
  BULLET,
  calloutHeaderAbove,
  HEADING,
  NUMBERED,
  QUOTE,
  selectedLines,
  TASK,
} from './editor-command-context.ts'
import type { Active, InlineKind, ListKind } from './editor-command-types.ts'
import { tableAt } from './editor-table-commands.ts'

const INLINE: Record<InlineKind, { node: string; mark: string }> = {
  bold: { node: 'StrongEmphasis', mark: '**' },
  italic: { node: 'Emphasis', mark: '*' },
  strike: { node: 'Strikethrough', mark: '~~' },
  code: { node: 'InlineCode', mark: '`' },
}

/** Which formats apply at the caret, so the toolbar can show them pressed. */
export function activeFormats(state: EditorState): Active {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head).text
  const heading = HEADING.exec(line)
  const inside = (kind: InlineKind) => {
    // At the very edge of the marks the caret still belongs to the formatted run.
    return (
      ancestorNamed(state, head, [INLINE[kind].node]) !== null ||
      ancestorNamed(state, Math.min(head + 1, state.doc.length), [INLINE[kind].node])?.from === head
    )
  }
  const quote = QUOTE.test(line)
  return {
    bold: inside('bold'),
    italic: inside('italic'),
    strike: inside('strike'),
    code: inside('code'),
    heading: heading ? (heading[1]!.length as Active['heading']) : 0,
    task: TASK.test(line),
    bullet: BULLET.test(line),
    numbered: NUMBERED.test(line),
    quote,
    link: ancestorNamed(state, head, ['Link']) !== null,
    codeBlock: blockNamed(state, head, ['FencedCode', 'CodeBlock']) !== null,
    callout: quote && calloutHeaderAbove(state, state.doc.lineAt(head).number) !== null,
    table: tableAt(state) !== null,
  }
}

// ---- inline formats ----------------------------------------------------------------------------------------------

/** Wraps the selection in marks, or removes them when the caret is already inside that format. */
export function toggleInline(view: EditorView, kind: InlineKind): boolean {
  const { node, mark } = INLINE[kind]
  const state = view.state
  const main = state.selection.main
  const found =
    ancestorNamed(state, main.head, [node]) ??
    (() => {
      const after = ancestorNamed(state, Math.min(main.head + 1, state.doc.length), [node])
      return after && after.from === main.head ? after : null
    })()
  if (found) {
    const marks = found.getChildren(
      kind === 'code' ? 'CodeMark' : kind === 'strike' ? 'StrikethroughMark' : 'EmphasisMark',
    )
    const changes: ChangeSpec[] = marks.map((m) => ({ from: m.from, to: m.to }))
    if (changes.length > 0) {
      view.dispatch({ changes, scrollIntoView: true })
      view.focus()
      return true
    }
  }
  const range = main.empty ? wordRange(state, main.head) : { from: main.from, to: main.to }
  if (range.from === range.to) {
    view.dispatch({
      changes: { from: range.from, insert: mark + mark },
      selection: { anchor: range.from + mark.length },
      scrollIntoView: true,
    })
  } else {
    view.dispatch({
      changes: [
        { from: range.from, insert: mark },
        { from: range.to, insert: mark },
      ],
      selection: EditorSelection.range(range.from + mark.length, range.to + mark.length),
      scrollIntoView: true,
    })
  }
  view.focus()
  return true
}

function wordRange(state: EditorState, pos: number): { from: number; to: number } {
  const word = state.wordAt(pos)
  return word ? { from: word.from, to: word.to } : { from: pos, to: pos }
}

// ---- line formats ------------------------------------------------------------------------------------------------

const stripList = (text: string) =>
  text.replace(TASK, '$1').replace(BULLET, '$1').replace(NUMBERED, '$1')

export function toggleList(view: EditorView, kind: ListKind): boolean {
  const lines = selectedLines(view.state)
  const re = kind === 'bullet' ? BULLET : kind === 'numbered' ? NUMBERED : TASK
  const content = lines.filter((line) => line.text.trim() !== '')
  const target = content.length > 0 ? content : lines
  const allHave = target.every((line) => re.test(line.text))
  const changes: ChangeSpec[] = []
  let number = 1
  for (const line of target) {
    const indent = /^\s*/.exec(line.text)![0]
    const body = stripList(line.text).slice(indent.length)
    const prefix = allHave
      ? ''
      : kind === 'bullet'
        ? '- '
        : kind === 'task'
          ? '- [ ] '
          : `${number}. `
    number += 1
    changes.push({ from: line.from, to: line.to, insert: indent + prefix + body })
  }
  view.dispatch({ changes, scrollIntoView: true })
  view.focus()
  return true
}

export function toggleQuote(view: EditorView): boolean {
  const lines = selectedLines(view.state)
  const content = lines.filter((line) => line.text.trim() !== '')
  const target = content.length > 0 ? content : lines
  const allQuoted = target.every((line) => QUOTE.test(line.text))
  view.dispatch({
    changes: target.map((line) => ({
      from: line.from,
      to: line.to,
      insert: allQuoted ? line.text.replace(QUOTE, '$1') : `> ${line.text}`,
    })),
    scrollIntoView: true,
  })
  view.focus()
  return true
}

/** Sets the heading level of the selected lines; the same level again turns it back into a paragraph. */
export function setHeading(view: EditorView, level: 0 | 1 | 2 | 3): boolean {
  const lines = selectedLines(view.state)
  const current = HEADING.exec(lines[0]?.text ?? '')?.[1]?.length ?? 0
  const next = current === level ? 0 : level
  view.dispatch({
    changes: lines.map((line) => ({
      from: line.from,
      to: line.to,
      insert: (next > 0 ? `${'#'.repeat(next)} ` : '') + line.text.replace(HEADING, ''),
    })),
    scrollIntoView: true,
  })
  view.focus()
  return true
}
