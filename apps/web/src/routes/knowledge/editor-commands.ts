import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorSelection, type ChangeSpec, type EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import {
  applyOp,
  canApply,
  cellRanges,
  cellStarts,
  columnAt,
  modelOf,
  newTable,
  serializeTable,
  type Align,
  type Cell,
  type TableModel,
  type TableOp,
} from './table-ops.ts'

// Formatting commands for the toolbar and the keyboard (PLAN 6.8). They only change the Markdown text, so the saved
// note is always plain Markdown.

export type InlineKind = 'bold' | 'italic' | 'strike' | 'code'
const INLINE: Record<InlineKind, { node: string; mark: string }> = {
  bold: { node: 'StrongEmphasis', mark: '**' },
  italic: { node: 'Emphasis', mark: '*' },
  strike: { node: 'Strikethrough', mark: '~~' },
  code: { node: 'InlineCode', mark: '`' },
}

export type ListKind = 'bullet' | 'numbered' | 'task'
export const CALLOUT_TYPES = ['note', 'tip', 'warning', 'danger'] as const
export type CalloutType = (typeof CALLOUT_TYPES)[number]

const BULLET = /^(\s*)([-*+])\s+(?!\[[ xX]\]\s)/
const TASK = /^(\s*)[-*+]\s+\[[ xX]\]\s+/
const NUMBERED = /^(\s*)\d+[.)]\s+/
const QUOTE = /^(\s*)>\s?/
const HEADING = /^(#{1,6})\s+/

// ---- what is under the caret -------------------------------------------------------------------------------------

function ancestorNamed(state: EditorState, pos: number, names: string[]): SyntaxNode | null {
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state)
  let node: SyntaxNode | null = tree.resolveInner(pos, -1)
  while (node) {
    if (names.includes(node.name)) return node
    node = node.parent
  }
  return null
}

export type Active = {
  bold: boolean
  italic: boolean
  strike: boolean
  code: boolean
  heading: 0 | 1 | 2 | 3 | 4 | 5 | 6
  bullet: boolean
  numbered: boolean
  task: boolean
  quote: boolean
  link: boolean
  codeBlock: boolean
  callout: boolean
  table: boolean
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
    codeBlock: ancestorNamed(state, head, ['FencedCode', 'CodeBlock']) !== null,
    callout: quote && calloutHeaderAbove(state, state.doc.lineAt(head).number) !== null,
    table: tableAt(state) !== null,
  }
}

function calloutHeaderAbove(state: EditorState, lineNumber: number): number | null {
  for (let n = lineNumber; n >= 1; n -= 1) {
    const text = state.doc.line(n).text
    if (!QUOTE.test(text)) return null
    if (/^\s*(?:>\s?)+\[![A-Za-z]+\]/.test(text)) return n
  }
  return null
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

function selectedLines(state: EditorState) {
  const doc = state.doc
  const seen = new Set<number>()
  const lines = []
  for (const range of state.selection.ranges) {
    const first = doc.lineAt(range.from).number
    let last = doc.lineAt(range.to).number
    // A selection that ends at the start of a line does not include that line.
    if (!range.empty && range.to === doc.line(last).from && last > first) last -= 1
    for (let n = first; n <= last; n += 1) {
      if (seen.has(n)) continue
      seen.add(n)
      lines.push(doc.line(n))
    }
  }
  return lines
}

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

// ---- blocks ------------------------------------------------------------------------------------------------------

/**
 * Puts a block of Markdown on its own lines (a blank line before and after) at the caret and returns the offset where
 * the block starts. The caret's line is replaced when it is empty, else the block goes after it.
 */
function insertBlock(
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
  const fenced = ancestorNamed(state, state.selection.main.head, ['FencedCode'])
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

// ---- links -------------------------------------------------------------------------------------------------------

export type LinkTarget = { kind: 'web'; url: string } | { kind: 'note'; target: string }

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

// ---- tables ------------------------------------------------------------------------------------------------------

export function insertTable(view: EditorView, columns: number, rows: number): boolean {
  const model = newTable(columns, rows)
  const text = serializeTable(model)
  const firstCell = cellStarts(model)[0]![0]!
  const header = model.header[0]!
  insertBlock(view, text, { from: firstCell, to: firstCell + header.length })
  return true
}

export type TableInfo = { from: number; to: number; cell: Cell; model: TableModel }

/** The table the caret is in (the whole block), with the caret's cell. */
export function tableAt(state: EditorState): TableInfo | null {
  const head = state.selection.main.head
  const node = ancestorNamed(state, head, ['Table'])
  if (!node) return null
  const source = state.sliceDoc(node.from, node.to)
  const model = modelOf(source)
  if (!model) return null
  const line = state.doc.lineAt(head)
  const firstLine = state.doc.lineAt(node.from).number
  const index = line.number - firstLine
  // The delimiter line (index 1) counts as the header row.
  const row = index <= 1 ? 0 : index - 1
  return {
    from: node.from,
    to: node.to,
    cell: { row, column: Math.min(columnAt(line.text, head - line.from), model.header.length - 1) },
    model,
  }
}

export function canApplyTableOp(state: EditorState, op: TableOp): boolean {
  const info = tableAt(state)
  return info !== null && canApply(info.model, info.cell, op)
}

export function applyTableOp(view: EditorView, op: TableOp): boolean {
  const info = tableAt(view.state)
  if (!info || !canApply(info.model, info.cell, op)) return false
  const result = applyOp(info.model, info.cell, op)
  const text = serializeTable(result.model)
  const starts = cellStarts(result.model)
  const row = Math.min(result.cell.row, starts.length - 1)
  const column = Math.min(result.cell.column, starts[row]!.length - 1)
  view.dispatch({
    changes: { from: info.from, to: info.to, insert: text },
    selection: { anchor: info.from + starts[row]![column]! },
    scrollIntoView: true,
  })
  view.focus()
  return true
}

export function alignColumn(view: EditorView, align: Align): boolean {
  return applyTableOp(view, { kind: 'align', align })
}

export function deleteTable(view: EditorView): boolean {
  const info = tableAt(view.state)
  if (!info) return false
  const { doc } = view.state
  const to = Math.min(info.to + 1, doc.length)
  view.dispatch({ changes: { from: info.from, to }, selection: { anchor: info.from } })
  view.focus()
  return true
}

/** Tab / Shift-Tab inside a table: the next / previous cell. The last cell's Tab adds a row. */
export function tableTab(view: EditorView, backwards: boolean): boolean {
  const state = view.state
  const info = tableAt(state)
  if (!info) return false
  const head = state.selection.main.head
  const firstLine = state.doc.lineAt(info.from).number
  const lastLine = state.doc.lineAt(info.to).number
  const line = state.doc.lineAt(head)
  const ranges = cellRanges(line.text)
  const column = columnAt(line.text, head - line.from)
  const go = (n: number, col: number) => {
    const target = view.state.doc.line(n)
    const cells = cellRanges(target.text)
    const cell = cells[Math.min(Math.max(col, 0), cells.length - 1)]!
    view.dispatch({
      selection: EditorSelection.range(target.from + cell.from, target.from + cell.to),
      scrollIntoView: true,
    })
    return true
  }
  // Line `firstLine + 1` is the delimiter row: skip it.
  const body = (n: number, direction: 1 | -1) => {
    const next = n + direction
    return next === firstLine + 1 ? next + direction : next
  }
  if (!backwards) {
    if (column < ranges.length - 1) return go(line.number, column + 1)
    if (line.number < lastLine) return go(body(line.number, 1), 0)
    if (!applyTableOp(view, { kind: 'row', where: 'below' })) return true
    return go(line.number + 1, 0)
  }
  if (column > 0) return go(line.number, column - 1)
  const previous = body(line.number, -1)
  if (previous < firstLine) return true
  return go(previous, Number.MAX_SAFE_INTEGER)
}
