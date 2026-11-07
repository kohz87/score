import type { AgentSummary, KnowledgeChanged, KnowledgeNoteSummary } from '@score/contract'

export type Session = { body: string; etag: string; version: number }
export type Status = 'saved' | 'dirty' | 'saving' | 'error'

export type NoteWorkspaceProps = {
  path: string
  notes: KnowledgeNoteSummary[]
  agents: AgentSummary[]
  /** Where a wikilink or a moved-note link opens. The classic page uses the router; the bold Library stays in its panel. */
  onOpenPath?: (path: string) => void
  /** The latest `knowledge.changed` for this note that did not come from this browser. */
  external: KnowledgeChanged | null
  onDismissExternal: () => void
  onCreateLink: (target: string) => void
  onMove: () => void
  onDelete: () => void
  /** Lets the page save the open draft before it moves the note. */
  registerFlush: (flush: (() => Promise<boolean>) | null) => void
}
