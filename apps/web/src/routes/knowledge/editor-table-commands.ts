import { EditorSelection, type EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { commitCellEdit, requestCellFocus } from './table-widget.ts'
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
  type TableOp,
} from './table-ops.ts'
import { blockNamed } from './editor-command-context.ts'
import type { TableInfo } from './editor-command-types.ts'
import { insertBlock } from './editor-block-commands.ts'

// ---- tables ------------------------------------------------------------------------------------------------------

const isLive = (view: EditorView) => view.dom.classList.contains('cm-live')

export function insertTable(view: EditorView, columns: number, rows: number): boolean {
  const model = newTable(columns, rows)
  const text = serializeTable(model)
  const firstCell = cellStarts(model)[0]![0]!
  const header = model.header[0]!
  const start = insertBlock(view, text, { from: firstCell, to: firstCell + header.length })
  if (isLive(view)) requestCellFocus(view, start, 0, 0, true)
  return true
}

/** The table the caret is in (the whole block), with the caret's cell. */
export function tableAt(state: EditorState): TableInfo | null {
  const head = state.selection.main.head
  const node = blockNamed(state, head, ['Table'])
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
  commitCellEdit(view)
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
  // In the live editor the table is a grid: the cell the action ended on gets the focus.
  if (isLive(view)) requestCellFocus(view, info.from, row, column)
  else view.focus()
  return true
}

export function alignColumn(view: EditorView, align: Align): boolean {
  return applyTableOp(view, { kind: 'align', align })
}

export function deleteTable(view: EditorView): boolean {
  commitCellEdit(view)
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
