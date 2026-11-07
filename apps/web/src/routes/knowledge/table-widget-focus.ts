import type { EditorView } from '@codemirror/view'
import type { PendingCellFocus } from './table-widget-types.ts'

const pending = new WeakMap<EditorView, PendingCellFocus>()

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

/** Takes the focus a redrawn table asked for, once it is in the document at the expected position. */
export function takeRequestedCellFocus(
  view: EditorView,
  wrap: HTMLElement,
): PendingCellFocus | null {
  const wanted = pending.get(view)
  if (!wanted || !wrap.isConnected || view.posAtDOM(wrap) !== wanted.from) return null
  pending.delete(view)
  return wanted
}
