import { WidgetType, type EditorView } from '@codemirror/view'
import { renderInline } from './live-table.ts'
import {
  copyCells,
  MIN_COLUMN,
  rangeOf,
  readWidths,
  widthsKey,
  writeWidths,
  type CellRange,
} from './table-extras.ts'
import {
  applyOp,
  cellRanges,
  cellStarts,
  modelOf,
  serializeTable,
  type TableModel,
} from './table-ops.ts'

/**
 * The table in the live editor (PLAN 6.8): always a rendered grid, never raw pipes. A click on a cell opens a
 * single-line editor in that cell; the cell shows its inline Markdown formatted again when it is not being edited.
 * Every edit rewrites the whole table as canonical GFM in one transaction (one undo step).
 *
 * Keys: Tab / Shift+Tab / arrows / Enter move between cells, Tab on the last cell adds a row, Escape leaves the grid.
 * Typing on a focused cell starts editing it. The editor's selection follows the focused cell, so the toolbar's table
 * tools act on it.
 */

export type TableHooks = {
  onOpenWikilink: (target: string) => void
  isMissing: (target: string) => boolean
  tableKey?: string
}

type Pending = { from: number; row: number; column: number; edit: boolean }
const pending = new WeakMap<EditorView, Pending>()

/** Asks the table starting at `from` (as it will be after the next transaction) to focus a cell when it is drawn. */
export function requestCellFocus(
  view: EditorView,
  from: number,
  row: number,
  column: number,
  edit = false,
): void {
  pending.set(view, { from, row, column, edit })
}

/** Saves a cell that is being typed in (its blur does it), so a toolbar action sees the text. */
export function commitCellEdit(view: EditorView): void {
  const active = document.activeElement
  if (
    active instanceof HTMLInputElement &&
    active.classList.contains('cm-lp-cell-input') &&
    view.dom.contains(active)
  )
    active.blur()
}

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

    // 3.8.3: dragged column widths, kept on this device for this note's table (the Markdown has no widths).
    const key = hooks.tableKey ? widthsKey(hooks.tableKey, model.header) : null
    const colgroup = document.createElement('colgroup')
    const cols = Array.from({ length: width }, () =>
      colgroup.appendChild(document.createElement('col')),
    )
    table.prepend(colgroup)
    const applyWidths = (widths: readonly number[] | null) => {
      table.style.tableLayout = widths ? 'fixed' : ''
      table.style.width = widths ? `${widths.reduce((sum, value) => sum + value, 0)}px` : ''
      cols.forEach((col, index) => (col.style.width = widths ? `${widths[index]}px` : ''))
    }
    applyWidths(key ? readWidths(key, width) : null)
    const resizer = (column: number) => {
      const handle = document.createElement('span')
      handle.className = 'cm-lp-col-resize'
      handle.setAttribute('aria-hidden', 'true')
      handle.title = 'Drag to widen; double-click to reset'
      handle.addEventListener('mousedown', (event) => event.stopPropagation())
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault()
        event.stopPropagation()
        // Start from what is drawn now, so switching to fixed widths doesn't jump.
        const widths = cells[0]!.map((cell) => cell.getBoundingClientRect().width)
        const from = event.clientX
        const before = widths[column]!
        handle.setPointerCapture(event.pointerId)
        const move = (next: PointerEvent) => {
          widths[column] = Math.max(MIN_COLUMN, before + next.clientX - from)
          applyWidths(widths)
        }
        const up = () => {
          handle.removeEventListener('pointermove', move)
          handle.removeEventListener('pointerup', up)
          handle.removeEventListener('pointercancel', up)
          if (key) writeWidths(key, widths)
        }
        handle.addEventListener('pointermove', move)
        handle.addEventListener('pointerup', up)
        handle.addEventListener('pointercancel', up)
      })
      handle.addEventListener('dblclick', (event) => {
        event.preventDefault()
        event.stopPropagation()
        applyWidths(null)
        if (key) writeWidths(key, null)
      })
      return handle
    }

    // 3.8.3: a range of cells (drag across them, or Shift with a click or an arrow) is selected and copied together.
    let anchor: { row: number; column: number } | null = null
    let range: CellRange | null = null
    let dragging = false
    const status = document.createElement('span')
    status.className = 'cm-lp-table-status'
    status.setAttribute('role', 'status')
    const showRange = (next: CellRange | null) => {
      range = next
      cells.forEach((line, row) =>
        line.forEach((cell, column) =>
          cell.classList.toggle(
            'cm-lp-cell-selected',
            next !== null &&
              row >= next.r0 &&
              row <= next.r1 &&
              column >= next.c0 &&
              column <= next.c1,
          ),
        ),
      )
    }
    const copy = (fallback: { row: number; column: number }) => {
      const area = range ?? rangeOf(fallback, fallback)
      const values: string[][] = []
      for (let row = area.r0; row <= area.r1; row += 1) {
        const line: string[] = []
        // What the cell shows (a cell being typed in: its text), so a spreadsheet gets "4", not "**4**".
        for (let column = area.c0; column <= area.c1; column += 1) {
          const cell = cells[row]![column]!
          line.push(cell.querySelector('input')?.value ?? cell.textContent ?? '')
        }
        values.push(line)
      }
      const count = values.length * values[0]!.length
      void copyCells(values).then((ok) => {
        status.textContent = ok
          ? `Copied ${count === 1 ? 'the cell' : `${count} cells`}`
          : 'Couldn’t copy. Select the text in a cell instead.'
        setTimeout(() => (status.textContent = ''), 2500)
      })
    }

    const paint = (cell: HTMLTableCellElement, row: number, column: number) => {
      cell.replaceChildren()
      renderInline(cell, valueAt(row, column), hooks)
      if (row === 0) cell.append(resizer(column))
    }

    /** The editor's caret follows the focused cell, so toolbar actions know which cell they are for. */
    const syncSelection = (row: number, column: number) => {
      const lineIndex = row === 0 ? 0 : row + 1
      const line = lines[lineIndex]
      if (line === undefined) return
      let offset = 0
      for (let index = 0; index < lineIndex; index += 1) offset += lines[index]!.length + 1
      const ranges = cellRanges(line)
      const range = ranges[Math.min(column, ranges.length - 1)]!
      const pos = start() + offset + range.from
      const main = view.state.selection.main
      if (view.state.sliceDoc(start(), start() + source.length) !== source) return
      if (main.empty && main.head === pos) return
      view.dispatch({ selection: { anchor: pos } })
    }

    const focusCell = (row: number, column: number, edit = false) => {
      const r = Math.min(Math.max(row, 0), rowCount - 1)
      const c = Math.min(Math.max(column, 0), width - 1)
      const cell = cells[r]![c]!
      for (const line of cells) for (const other of line) other.tabIndex = -1
      cell.tabIndex = 0
      if (edit) startEdit(r, c)
      else cell.focus()
    }

    /** Writes the edited table back; the cell to focus next (if any) is drawn focused by the new widget. */
    const commit = (
      edited: TableModel,
      changed: boolean,
      next: { row: number; column: number; edit: boolean } | null,
      at: { row: number; column: number },
    ): boolean => {
      const from = start()
      if (view.state.sliceDoc(from, from + source.length) !== source) return false
      if (!changed) return true
      if (next) requestCellFocus(view, from, next.row, next.column, next.edit)
      // The caret stays in the cell that was edited (or moves to the next), so toolbar actions know their cell.
      const starts = cellStarts(edited)
      const place = next ?? at
      const row = Math.min(place.row, starts.length - 1)
      view.dispatch({
        changes: { from, to: from + source.length, insert: serializeTable(edited) },
        selection: {
          anchor: from + starts[row]![Math.min(place.column, starts[row]!.length - 1)]!,
        },
        userEvent: 'input',
      })
      return true
    }

    const withValue = (row: number, column: number, value: string): TableModel => {
      const copy: TableModel = {
        header: [...model.header],
        align: [...model.align],
        rows: model.rows.map((line) => [...line]),
      }
      if (row === 0) copy.header[column] = value
      else copy.rows[row - 1]![column] = value
      return copy
    }

    /** Leaves the editing cell. `to` is where to go; Tab on the very last cell adds a row. */
    const finish = (
      row: number,
      column: number,
      input: HTMLInputElement,
      to: { row: number; column: number } | 'new-row' | 'blur' | null,
      edit: boolean,
    ) => {
      if (input.dataset.done) return
      input.dataset.done = '1'
      const value = input.value.replace(/\s+/g, ' ').trim()
      let edited = value === valueAt(row, column) ? model : withValue(row, column, value)
      let changed = edited !== model
      let target = to === 'new-row' || to === 'blur' ? null : to
      if (to === 'new-row') {
        const result = applyOp(
          edited,
          { row: rowCount - 1, column: width - 1 },
          { kind: 'row', where: 'below' },
        )
        edited = result.model
        changed = true
        target = { row: rowCount, column: 0 }
      }
      const done = commit(edited, changed, target ? { ...target, edit } : null, { row, column })
      if (done && changed) return
      // Nothing was rewritten: this grid stays, so put the cell back and move.
      paint(cells[row]![column]!, row, column)
      if (target) focusCell(target.row, target.column, edit)
      else if (to !== 'blur') cells[row]![column]!.focus()
    }

    const startEdit = (row: number, column: number, initial?: string) => {
      const cell = cells[row]![column]!
      if (cell.querySelector('input')) return
      const input = document.createElement('input')
      input.type = 'text'
      // No intrinsic width of its own: the cell keeps the column's width while it is edited.
      input.size = 1
      input.className = 'cm-lp-cell-input'
      input.value = initial ?? valueAt(row, column)
      const label = model.header[column] || `Column ${column + 1}`
      input.setAttribute('aria-label', row === 0 ? `Header, ${label}` : `${label}, row ${row}`)
      cell.replaceChildren(input)
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
      syncSelection(row, column)
      const atLast = row === rowCount - 1 && column === width - 1
      input.addEventListener('keydown', (event) => {
        const go = (to: { row: number; column: number } | 'new-row' | null) => {
          event.preventDefault()
          finish(row, column, input, to, to !== null)
        }
        if (event.key === 'Enter') go(row < rowCount - 1 ? { row: row + 1, column } : null)
        else if (event.key === 'Tab' && !event.shiftKey) {
          if (atLast) go('new-row')
          else go(column < width - 1 ? { row, column: column + 1 } : { row: row + 1, column: 0 })
        } else if (event.key === 'Tab') {
          const first = row === 0 && column === 0
          if (first) go(null)
          else go(column > 0 ? { row, column: column - 1 } : { row: row - 1, column: width - 1 })
        } else if (event.key === 'ArrowDown' && row < rowCount - 1) go({ row: row + 1, column })
        else if (event.key === 'ArrowUp' && row > 0) go({ row: row - 1, column })
        else if (event.key === 'Escape') {
          event.preventDefault()
          input.dataset.done = '1'
          paint(cell, row, column)
          cell.focus()
        } else if (
          event.key === 'ArrowRight' &&
          input.selectionStart === input.value.length &&
          column < width - 1
        )
          go({ row, column: column + 1 })
        else if (event.key === 'ArrowLeft' && input.selectionEnd === 0 && column > 0)
          go({ row, column: column - 1 })
      })
      // Leaving the cell any other way (a click elsewhere) keeps what was typed.
      input.addEventListener('blur', () => finish(row, column, input, 'blur', false))
    }

    for (let row = 0; row < rowCount; row += 1) {
      const tr = row === 0 ? head : body.insertRow()
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
        paint(cell, row, column)
        cell.addEventListener('focus', () => {
          syncSelection(row, column)
          // Shift+click or Shift+arrow without a range grows from the cell that has focus.
          if (!range) anchor = { row, column }
        })
        cell.addEventListener('mousedown', (event) => {
          const target = event.target as HTMLElement
          if (target instanceof HTMLInputElement) return
          const link = target.closest<HTMLElement>('[data-wikilink]')
          if (link) {
            event.preventDefault()
            hooks.onOpenWikilink(link.dataset.wikilink!)
            return
          }
          if (target.closest('a')) return
          event.preventDefault()
          if (event.shiftKey && anchor) {
            showRange(rangeOf(anchor, { row, column }))
            focusCell(row, column)
            return
          }
          // A press edits the cell, as before; dragging on into other cells ends that edit and selects them instead.
          anchor = { row, column }
          showRange(null)
          dragging = true
          const release = () => {
            document.removeEventListener('mouseup', release)
            dragging = false
          }
          document.addEventListener('mouseup', release)
          focusCell(row, column, true)
        })
        cell.addEventListener('mouseenter', () => {
          if (!dragging || !anchor || (anchor.row === row && anchor.column === column)) return
          // Leaving the pressed cell: its edit ends (its blur saves only what was typed) and the range starts.
          const pressed = cells[anchor.row]![anchor.column]!
          pressed.querySelector('input')?.blur()
          // Text typed there was saved, which redraws the table: this grid is gone, so there is no range to show.
          if (!wrap.isConnected) return
          showRange(rangeOf(anchor, { row, column }))
          pressed.focus()
        })
        cell.addEventListener('keydown', (event) => {
          if (event.target !== cell) return
          const moves: Record<string, [number, number]> = {
            ArrowRight: [0, 1],
            ArrowLeft: [0, -1],
            ArrowDown: [1, 0],
            ArrowUp: [-1, 0],
          }
          const move = moves[event.key]
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
            event.preventDefault()
            copy({ row, column })
          } else if (move && event.shiftKey) {
            // Shift+arrow grows the range from where it started.
            event.preventDefault()
            // A new range starts at the focused cell; an existing one keeps where it started.
            if (!range) anchor = { row, column }
            const to = {
              row: Math.min(Math.max(row + move[0], 0), rowCount - 1),
              column: Math.min(Math.max(column + move[1], 0), width - 1),
            }
            showRange(rangeOf(anchor ?? { row, column }, to))
            focusCell(to.row, to.column)
          } else if (move) {
            event.preventDefault()
            anchor = { row: row + move[0], column: column + move[1] }
            showRange(null)
            focusCell(row + move[0], column + move[1])
          } else if (event.key === 'Enter' || event.key === 'F2') {
            event.preventDefault()
            focusCell(row, column, true)
          } else if (event.key === 'Tab' && !event.shiftKey) {
            if (row === rowCount - 1 && column === width - 1) {
              event.preventDefault()
              commit(
                applyOp(
                  model,
                  { row: rowCount - 1, column: width - 1 },
                  { kind: 'row', where: 'below' },
                ).model,
                true,
                { row: rowCount, column: 0, edit: false },
                { row, column },
              )
            } else {
              event.preventDefault()
              if (column < width - 1) focusCell(row, column + 1)
              else focusCell(row + 1, 0)
            }
          } else if (event.key === 'Tab') {
            if (row === 0 && column === 0) return
            event.preventDefault()
            if (column > 0) focusCell(row, column - 1)
            else focusCell(row - 1, width - 1)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            if (range) {
              showRange(null)
              anchor = { row, column }
            } else view.contentDOM.focus()
          } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            // Typing on a cell replaces its content, as in a spreadsheet.
            event.preventDefault()
            for (const other of cells.flat()) other.tabIndex = -1
            cell.tabIndex = 0
            startEdit(row, column, event.key)
          }
        })
        tr.append(cell)
        line.push(cell)
      }
      cells.push(line)
    }
    wrap.append(table, status)

    // A table redrawn after an edit or a toolbar action takes the focus the action asked for.
    requestAnimationFrame(() => {
      const wanted = pending.get(view)
      if (!wanted || !wrap.isConnected || view.posAtDOM(wrap) !== wanted.from) return
      pending.delete(view)
      focusCell(wanted.row, wanted.column, wanted.edit)
    })
    return wrap
  }
}
