import {
  followGrip,
  heightsKey,
  MIN_COLUMN,
  MIN_ROW,
  readHeights,
  readWidths,
  scaleWidths,
  toSize,
  widthsKey,
  writeHeights,
  writeWidths,
  type TableSize,
} from './table-extras.ts'

type TableResizeOptions = {
  wrap: HTMLElement
  table: HTMLTableElement
  cells: HTMLTableCellElement[][]
  header: readonly string[]
  rowCount: number
  tableKey?: string
}

export type TableResize = {
  trackRow: (row: HTMLTableRowElement) => void
  applyStoredHeights: () => void
  rowGrip: (row: number) => HTMLSpanElement
  tableGrip: () => HTMLSpanElement
  resizer: (column: number) => HTMLSpanElement
}

export function createTableResize({
  wrap,
  table,
  cells,
  header,
  rowCount,
  tableKey,
}: TableResizeOptions): TableResize {
  // 3.8.3: dragged column widths, kept on this device for this note's table (the Markdown has no widths).
  const key = tableKey ? widthsKey(tableKey, header) : null
  const colgroup = document.createElement('colgroup')
  const cols = Array.from({ length: header.length }, () =>
    colgroup.appendChild(document.createElement('col')),
  )
  table.prepend(colgroup)
  // 3.8.5: shares, not pixels, so a size set on one screen fits another.
  const applySize = (size: TableSize | null) => {
    table.style.tableLayout = size ? 'fixed' : ''
    table.style.width = size ? `${(size.table * 100).toFixed(2)}%` : ''
    // On a smaller screen the table shrinks with it, but not below 60% of the width it was given (its words would
    // split); past that it scrolls. A per-column floor would force tables with a narrow "#" column to full width.
    table.style.minWidth = size?.px ? `${Math.round(size.px * 0.6)}px` : ''
    cols.forEach(
      (col, index) => (col.style.width = size ? `${(size.cols[index]! * 100).toFixed(2)}%` : ''),
    )
  }
  const available = () => wrap.clientWidth
  const applyWidths = (widths: readonly number[] | null) =>
    applySize(widths ? toSize(widths, available()) : null)
  const saveWidths = (widths: readonly number[]) =>
    key && writeWidths(key, toSize(widths, available()))
  applySize(key ? readWidths(key, header.length) : null)
  const drawnWidths = () => cells[0]!.map((cell) => cell.getBoundingClientRect().width)

  // 3.8.4 (owner): the whole table (a corner grip scales every column) and each row's height (a grip on its first
  // cell's bottom edge), kept the same way.
  const hKey = tableKey ? heightsKey(tableKey, header) : null
  const rowsDrawn: HTMLTableRowElement[] = []
  let heights: (number | null)[] = Array.from({ length: rowCount }, () => null)
  const applyHeights = () =>
    rowsDrawn.forEach(
      (tr, index) => (tr.style.height = heights[index] ? `${heights[index]}em` : ''),
    )
  const emPx = () => parseFloat(getComputedStyle(table).fontSize) || 14
  const rowGrip = (row: number) => {
    const handle = document.createElement('span')
    handle.className = 'cm-lp-row-resize'
    handle.setAttribute('aria-hidden', 'true')
    handle.title = 'Drag to change the row’s height; double-click to reset'
    handle.addEventListener('mousedown', (event) => event.stopPropagation())
    handle.addEventListener('pointerdown', (event) => {
      const before = rowsDrawn[row]!.getBoundingClientRect().height
      followGrip(
        handle,
        event,
        (_dx, dy) => {
          heights[row] = Math.max(MIN_ROW, (before + dy) / emPx())
          applyHeights()
        },
        () => hKey && writeHeights(hKey, heights),
      )
    })
    handle.addEventListener('dblclick', (event) => {
      event.preventDefault()
      event.stopPropagation()
      heights[row] = null
      applyHeights()
      if (hKey) writeHeights(hKey, heights)
    })
    return handle
  }
  const tableGrip = () => {
    const handle = document.createElement('span')
    handle.className = 'cm-lp-table-resize'
    handle.setAttribute('aria-hidden', 'true')
    handle.title = 'Drag to resize the whole table; double-click to reset'
    handle.addEventListener('mousedown', (event) => event.stopPropagation())
    handle.addEventListener('pointerdown', (event) => {
      const before = drawnWidths()
      const total = before.reduce((sum, value) => sum + value, 0)
      let widths = before
      followGrip(
        handle,
        event,
        (dx) => {
          widths = scaleWidths(before, total + dx)
          applyWidths(widths)
        },
        () => saveWidths(widths),
      )
    })
    handle.addEventListener('dblclick', (event) => {
      event.preventDefault()
      event.stopPropagation()
      applySize(null)
      if (key) writeWidths(key, null)
    })
    return handle
  }
  const resizer = (column: number) => {
    const handle = document.createElement('span')
    handle.className = 'cm-lp-col-resize'
    handle.setAttribute('aria-hidden', 'true')
    handle.title = 'Drag to widen; double-click to reset'
    handle.addEventListener('mousedown', (event) => event.stopPropagation())
    handle.addEventListener('pointerdown', (event) => {
      // Start from what is drawn now, so switching to fixed widths doesn't jump.
      const widths = drawnWidths()
      const before = widths[column]!
      followGrip(
        handle,
        event,
        (dx) => {
          widths[column] = Math.max(MIN_COLUMN, before + dx)
          applyWidths(widths)
        },
        () => saveWidths(widths),
      )
    })
    handle.addEventListener('dblclick', (event) => {
      event.preventDefault()
      event.stopPropagation()
      applySize(null)
      if (key) writeWidths(key, null)
    })
    return handle
  }

  return {
    trackRow: (row) => rowsDrawn.push(row),
    applyStoredHeights: () => {
      heights = (hKey ? readHeights(hKey, rowCount) : null) ?? heights
      applyHeights()
    },
    rowGrip,
    tableGrip,
    resizer,
  }
}
