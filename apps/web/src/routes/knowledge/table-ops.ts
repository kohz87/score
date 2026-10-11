import { parseTable, splitRow, type ParsedTable } from './live-table.ts'

// Table editing on the Markdown text (PLAN 6.8). Every operation reads the table, changes the model and writes it back
// as canonical GFM: `| a | b |`, delimiter row `| --- | :-: |`, pipes inside cells escaped as `\|`.

export type Align = 'left' | 'center' | 'right' | null
export type TableModel = { header: string[]; align: Align[]; rows: string[][] }

const MAX_SIZE = 8

const escapeCell = (cell: string) => cell.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

const delimiterOf = (align: Align) =>
  align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---'

/** A table as canonical GFM text (no trailing newline). */
export function serializeTable(model: TableModel): string {
  const width = model.header.length
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => escapeCell(cells[index] ?? '')).join(' | ')} |`
  return [
    line(model.header),
    `| ${model.align.map(delimiterOf).join(' | ')} |`,
    ...model.rows.map(line),
  ].join('\n')
}

/** A fresh table for the size picker: `rows` counts the header row. */
export function newTable(columns: number, rows: number): TableModel {
  const width = Math.min(Math.max(columns, 1), MAX_SIZE)
  const height = Math.min(Math.max(rows, 1), MAX_SIZE)
  return {
    header: Array.from({ length: width }, (_, index) => `Column ${index + 1}`),
    align: Array.from({ length: width }, () => null),
    rows: Array.from({ length: height - 1 }, () => Array.from({ length: width }, () => '')),
  }
}

export function modelOf(source: string): TableModel | null {
  const parsed: ParsedTable | null = parseTable(source)
  if (!parsed) return null
  const width = parsed.header.length
  return {
    header: parsed.header,
    align: parsed.align,
    rows: parsed.rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? '')),
  }
}

/** Where the caret is: row 0 is the header, rows 1.. are body rows (the delimiter line is not a row). */
export type Cell = { row: number; column: number }

export type TableOp =
  | { kind: 'row'; where: 'above' | 'below' }
  | { kind: 'delete-row' }
  | { kind: 'column'; where: 'left' | 'right' }
  | { kind: 'delete-column' }
  | { kind: 'move-column'; direction: 'left' | 'right' }
  | { kind: 'align'; align: Align }

/** Can this operation run at this cell? (Used to disable the toolbar buttons.) */
export function canApply(model: TableModel, cell: Cell, op: TableOp): boolean {
  switch (op.kind) {
    case 'row':
      return model.rows.length < 200 && !(op.where === 'above' && cell.row === 0)
    case 'delete-row':
      return cell.row > 0
    case 'column':
      return model.header.length < 40
    case 'delete-column':
      return model.header.length > 1
    case 'move-column':
      return op.direction === 'left' ? cell.column > 0 : cell.column < model.header.length - 1
    case 'align':
      return true
  }
}

/** Applies the operation; returns the new model and where the caret goes. */
export function applyOp(
  model: TableModel,
  cell: Cell,
  op: TableOp,
): { model: TableModel; cell: Cell } {
  const width = model.header.length
  const blank = () => Array.from({ length: width }, () => '')
  const next: TableModel = {
    header: [...model.header],
    align: [...model.align],
    rows: model.rows.map((row) => [...row]),
  }
  switch (op.kind) {
    case 'row': {
      // Above the header means below it: the header is always the first row.
      const at = op.where === 'above' ? Math.max(cell.row - 1, 0) : Math.max(cell.row, 0)
      next.rows.splice(at, 0, blank())
      return { model: next, cell: { row: at + 1, column: cell.column } }
    }
    case 'delete-row': {
      if (cell.row === 0) return { model, cell }
      next.rows.splice(cell.row - 1, 1)
      return {
        model: next,
        cell: { row: Math.min(cell.row, next.rows.length), column: cell.column },
      }
    }
    case 'column': {
      const at = op.where === 'left' ? cell.column : cell.column + 1
      next.header.splice(at, 0, `Column ${at + 1}`)
      next.align.splice(at, 0, null)
      for (const row of next.rows) row.splice(at, 0, '')
      return { model: next, cell: { row: cell.row, column: at } }
    }
    case 'delete-column': {
      if (width <= 1) return { model, cell }
      next.header.splice(cell.column, 1)
      next.align.splice(cell.column, 1)
      for (const row of next.rows) row.splice(cell.column, 1)
      return { model: next, cell: { row: cell.row, column: Math.min(cell.column, width - 2) } }
    }
    case 'move-column': {
      const to = op.direction === 'left' ? cell.column - 1 : cell.column + 1
      if (to < 0 || to >= width) return { model, cell }
      const swap = <T>(list: T[]) => {
        const moved = list[cell.column] as T
        list[cell.column] = list[to] as T
        list[to] = moved
      }
      swap(next.header)
      swap(next.align)
      for (const row of next.rows) swap(row)
      return { model: next, cell: { row: cell.row, column: to } }
    }
    case 'align': {
      next.align[cell.column] = op.align
      return { model: next, cell }
    }
  }
}

/** The offset of the first character of each cell's content in `serializeTable(model)`, by row (0 = header). */
export function cellStarts(model: TableModel): number[][] {
  const text = serializeTable(model).split('\n')
  const lines = [text[0]!, ...text.slice(2)]
  const offsets: number[] = []
  let at = 0
  for (const line of text) {
    offsets.push(at)
    at += line.length + 1
  }
  const starts = [offsets[0]!, ...offsets.slice(2)]
  return lines.map((line, index) => {
    const out: number[] = []
    // Cells begin after "| " and after each " | ".
    let position = 2
    out.push(starts[index]! + position)
    for (let cut = line.indexOf(' | ', 2); cut !== -1; cut = line.indexOf(' | ', cut + 3)) {
      position = cut + 3
      out.push(starts[index]! + position)
    }
    return out
  })
}

// ---- reading the caret's cell from raw lines ---------------------------------------------------------------------

export type CellRange = { from: number; to: number }

/** The trimmed content range of each cell in one row line (offsets within the line). Empty cells get a zero-width range. */
export function cellRanges(line: string): CellRange[] {
  const ranges: CellRange[] = []
  const raw = line
  let start = 0
  let cursor = 0
  if (/^\s*\|/.test(raw)) {
    start = raw.indexOf('|') + 1
    cursor = start
  }
  let code = false
  const push = (from: number, to: number) => {
    let a = from
    let b = to
    while (a < b && /\s/.test(raw[a]!)) a += 1
    while (b > a && /\s/.test(raw[b - 1]!)) b -= 1
    ranges.push({
      from: a < b ? a : Math.min(from + 1, to),
      to: a < b ? b : Math.min(from + 1, to),
    })
  }
  const trailing = /\|\s*$/.test(raw) && !/\\\|\s*$/.test(raw) ? raw.lastIndexOf('|') : raw.length
  for (let index = start; index < trailing; index += 1) {
    const char = raw[index]!
    if (char === '\\' && raw[index + 1] === '|') index += 1
    else if (char === '`') code = !code
    else if (char === '|' && !code) {
      push(cursor, index)
      cursor = index + 1
    }
  }
  push(cursor, trailing)
  return ranges
}

/** Which cell (column index) contains the offset `col` of a row line. */
export function columnAt(line: string, col: number): number {
  const ranges = cellRanges(line)
  let found = 0
  ranges.forEach((range, index) => {
    if (col >= range.from) found = index
  })
  return found
}

export { splitRow }
