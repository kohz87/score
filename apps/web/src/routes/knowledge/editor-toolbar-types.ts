import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { KnowledgeNoteSummary } from '@score/contract'

export type Panel = 'heading' | 'code' | 'callout' | 'table' | 'link' | null

export type EditorToolbarProps = {
  view: EditorView | null
  state: EditorState | null
  notes: KnowledgeNoteSummary[]
  /** Problem with the last image, in words. */
  notice: string | null
  onNotice: (message: string | null) => void
  /** Bumps when a keyboard shortcut asks for the link dialog. */
  linkRequest: number
}
