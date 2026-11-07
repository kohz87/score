import { WidgetType, type EditorView } from '@codemirror/view'
import { modelOf } from './table-ops.ts'
import { createTableCellController } from './table-widget-cells.ts'
import { takeRequestedCellFocus } from './table-widget-focus.ts'
import { createTableResize } from './table-widget-resize.ts'
import type { TableHooks } from './table-widget-types.ts'

export { commitCellEdit, requestCellFocus } from './table-widget-focus.ts'
export type { TableHooks } from './table-widget-types.ts'

/**
 * The table in the live editor (PLAN 6.8): always a rendered grid, never raw pipes. A click on a cell opens a
 * single-line editor in that cell; the cell shows its inline Markdown formatted again when it is not being edited.
 * Every edit rewrites the whole table as canonical GFM in one transaction (one undo step).
 *
 * Keys: Tab / Shift+Tab / arrows / Enter move between cells, Tab on the last cell adds a row, Escape leaves the grid.
 * Typing on a focused cell starts editing it. The editor's selection follows the focused cell, so the toolbar's table
 * tools act on it.
 */

export class TableWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly hooks: TableHooks,
  ) {
    super()
  }
  override eq(other: TableWidget) {
    return other.source === this.source
  }
  override ignoreEvent() {
    return true
  }

  override toDOM(view: EditorView) {
    const source = this.source
    const hooks = this.hooks
    const model = modelOf(source)
    const wrap = document.createElement('div')
    wrap.className = 'cm-lp-table'
    if (!model) {
      wrap.textContent = source
      return wrap
    }
    const table = document.createElement('table')
    table.setAttribute('aria-label', 'Table')
    const head = table.createTHead().insertRow()
    const body = table.createTBody()
    const cells: HTMLTableCellElement[][] = []
    const lines = source.split('\n').filter((line) => line.trim() !== '')
    const rowCount = model.rows.length + 1
    const width = model.header.length
    const valueAt = (row: number, column: number) =>
      row === 0 ? model.header[column]! : (model.rows[row - 1]?.[column] ?? '')
    const start = () => view.posAtDOM(wrap)

    const resize = createTableResize({
      wrap,
      table,
      cells,
      header: model.header,
      rowCount,
      tableKey: hooks.tableKey,
    })
    const { rowGrip, tableGrip, resizer } = resize
    const cellController = createTableCellController({
      view,
      source,
      hooks,
      model,
      wrap,
      cells,
      lines,
      rowCount,
      width,
      valueAt,
      start,
      resizer,
      rowGrip,
      tableGrip,
    })

    for (let row = 0; row < rowCount; row += 1) {
      const tr = row === 0 ? head : body.insertRow()
      resize.trackRow(tr)
      const line: HTMLTableCellElement[] = []
      for (let column = 0; column < width; column += 1) {
        const cell = document.createElement(row === 0 ? 'th' : 'td')
        if (row === 0) cell.scope = 'col'
        const align = model.align[column]
        if (align) cell.style.textAlign = align
        cell.tabIndex = row === 0 && column === 0 ? 0 : -1
        cell.className = 'cm-lp-cell'
        cell.dataset.row = String(row)
        cell.dataset.column = String(column)
        cellController.attach(cell, row, column)
        tr.append(cell)
        line.push(cell)
      }
      cells.push(line)
    }
    resize.applyStoredHeights()
    wrap.append(table, cellController.status)

    // A table redrawn after an edit or a toolbar action takes the focus the action asked for.
    requestAnimationFrame(() => {
      const wanted = takeRequestedCellFocus(view, wrap)
      if (!wanted) return
      cellController.focusCell(wanted.row, wanted.column, wanted.edit)
    })
    return wrap
  }
}
