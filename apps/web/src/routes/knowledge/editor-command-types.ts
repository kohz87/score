import type { Cell, TableModel } from './table-ops.ts'

export type InlineKind = 'bold' | 'italic' | 'strike' | 'code'

export type ListKind = 'bullet' | 'numbered' | 'task'
export const CALLOUT_TYPES = ['note', 'tip', 'warning', 'danger'] as const
export type CalloutType = (typeof CALLOUT_TYPES)[number]

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

export type LinkTarget = { kind: 'web'; url: string } | { kind: 'note'; target: string }

export type TableInfo = { from: number; to: number; cell: Cell; model: TableModel }
