export type TableHooks = {
  onOpenWikilink: (target: string) => void
  isMissing: (target: string) => boolean
  tableKey?: string
}

export type CellPosition = { row: number; column: number }

export type PendingCellFocus = CellPosition & { from: number; edit: boolean }
