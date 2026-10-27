import { copyText } from '../../data/clipboard.ts'

// 3.8.3 (owner): dragged column widths (remembered on this device, never written into the note: Markdown has no widths)
// and copying a range of cells.

const PREFIX = 'score.tableWidths:'
export const MIN_COLUMN = 48

/** The key a table's widths are kept under: the note's path and the table's header row. */
export function widthsKey(note: string, header: readonly string[]): string {
  return `${PREFIX}${note}\u0001${header.join('\u0001')}`
}

/**
 * 3.8.5 (owner: "shouldn't the size be subject to screen resolution?"): a table's size relative to its space, so it
 * looks the same on any screen. `table` is its width as a share of the editor's line (1 = the whole line; more scrolls
 * sideways); `cols` are each column's share of the table.
 */
export type TableSize = {
  table: number
  cols: number[]
  /** The table's width in pixels when it was sized: on a smaller screen it shrinks to 60% of it, then scrolls. */
  px?: number
}

/** Drawn pixel widths as a size relative to the space they were drawn in. */
export function toSize(widths: readonly number[], available: number): TableSize {
  const total = widths.reduce((sum, value) => sum + value, 0)
  return {
    table: total / Math.max(available, 1),
    cols: widths.map((value) => value / Math.max(total, 1)),
    px: Math.round(total),
  }
}

export function readWidths(key: string, columns: number): TableSize | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    // Pixel arrays from 3.8.3/3.8.4 don't fit another screen: they are dropped and the table lays out again.
    const parsed = JSON.parse(raw) as { v?: unknown; table?: unknown; cols?: unknown; px?: unknown }
    const { table, cols, px } = parsed
    if (
      parsed.v !== 2 ||
      typeof table !== 'number' ||
      !(table > 0 && table <= 10) ||
      !Array.isArray(cols) ||
      cols.length !== columns ||
      !cols.every((value) => typeof value === 'number' && value > 0 && value <= 1)
    )
      return null
    const sum = (cols as number[]).reduce((total, value) => total + value, 0)
    return {
      table,
      cols: (cols as number[]).map((value) => value / sum),
      ...(typeof px === 'number' && px > 0 && px < 20000 ? { px } : {}),
    }
  } catch {
    return null
  }
}

export function writeWidths(key: string, size: TableSize | null): void {
  try {
    if (size) localStorage.setItem(key, JSON.stringify({ v: 2, ...size }))
    else localStorage.removeItem(key)
  } catch {
    // Storage can be blocked (private window): the widths last until the table is redrawn.
  }
}

// 3.8.4 (owner): row heights, the same way (per note and header row, on this device). `null` is a row left to fit.
// 3.8.5: in `em` of the table's text, so they follow the text size, not the screen's pixels.
const HEIGHTS = 'score.tableHeights2:'
export const MIN_ROW = 1.75

export function heightsKey(note: string, header: readonly string[]): string {
  return `${HEIGHTS}${note}\u0001${header.join('\u0001')}`
}

export function readHeights(key: string, rows: number): (number | null)[] | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (
      !Array.isArray(parsed) ||
      parsed.length !== rows ||
      !parsed.every(
        (value) => value === null || (typeof value === 'number' && Number.isFinite(value)),
      )
    )
      return null
    return parsed.map((value: number | null) =>
      value === null ? null : Math.max(MIN_ROW, Math.round(value * 100) / 100),
    )
  } catch {
    return null
  }
}

export function writeHeights(key: string, heights: readonly (number | null)[] | null): void {
  try {
    if (heights && heights.some((value) => value !== null))
      localStorage.setItem(
        key,
        JSON.stringify(
          heights.map((value) => (value === null ? null : Math.round(value * 100) / 100)),
        ),
      )
    else localStorage.removeItem(key)
  } catch {
    // As for widths: they last until the table is redrawn.
  }
}

/** Follows a pointer from a grip until it is let go; `move` gets the distance travelled. */
export function followGrip(
  handle: HTMLElement,
  event: PointerEvent,
  move: (dx: number, dy: number) => void,
  done: () => void,
): void {
  event.preventDefault()
  event.stopPropagation()
  const x = event.clientX
  const y = event.clientY
  handle.setPointerCapture(event.pointerId)
  let moved = false
  const onMove = (next: PointerEvent) => {
    moved = true
    move(next.clientX - x, next.clientY - y)
  }
  const onUp = () => {
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('pointercancel', onUp)
    // A click (the first half of a double-click reset) saves nothing; only a drag does.
    if (moved) done()
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('pointercancel', onUp)
}

/** Every column scaled by the same factor so the table is `total` wide (none below the minimum). */
export function scaleWidths(widths: readonly number[], total: number): number[] {
  const now = widths.reduce((sum, value) => sum + value, 0)
  const factor = Math.max(total, MIN_COLUMN * widths.length) / now
  return widths.map((value) => Math.max(MIN_COLUMN, value * factor))
}

export type CellRange = { r0: number; c0: number; r1: number; c1: number }

/** The rectangle between two cells, whichever way it was dragged. */
export function rangeOf(
  a: { row: number; column: number },
  b: { row: number; column: number },
): CellRange {
  return {
    r0: Math.min(a.row, b.row),
    c0: Math.min(a.column, b.column),
    r1: Math.max(a.row, b.row),
    c1: Math.max(a.column, b.column),
  }
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The cells as tab-separated text (pastes into a spreadsheet) and as an HTML table (pastes into a document). */
export function rangeText(values: string[][]): { plain: string; html: string } {
  return {
    plain: values
      .map((row) => row.map((value) => value.replace(/[\t\n]/g, ' ')).join('\t'))
      .join('\n'),
    html: `<table>${values
      .map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`)
      .join('')}</table>`,
  }
}

export function copyCells(values: string[][]): Promise<boolean> {
  const { plain, html } = rangeText(values)
  return copyText(plain, html)
}
