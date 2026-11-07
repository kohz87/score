import type { KnowledgeExportRequest, KnowledgeNoteSummary } from '@score/contract'
import { folderOf } from '../routes/knowledge/knowledge-paths.ts'

export type Dialog =
  | { kind: 'new'; initial: string }
  | { kind: 'move'; path: string }
  | { kind: 'delete'; path: string }
  | { kind: 'folder'; parent: string; fromNav?: boolean }
  | { kind: 'folder-move'; path: string }
  | { kind: 'folder-delete'; path: string }
  | null

export type ExportRequest = { request: KnowledgeExportRequest; heading: string }
export const PHONE = '(max-width: 860px)'
// The Knowledge page goes to one column where the shell itself switches to its phone layout (the tab bar).
export const PAGE_PHONE = '(max-width: 860px)'
export const COLLAPSED_KEY = 'score.library.collapsed'

export function readCollapsed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return new Set(
      Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [],
    )
  } catch {
    return new Set()
  }
}

/** `a/b/c` is inside `a/b/c`, `a/b` and `a`. */
export function folderChain(folder: string): string[] {
  const parts = folder.split('/').filter(Boolean)
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

export function noteGroups(tree: { folders: string[]; notes: KnowledgeNoteSummary[] }) {
  const groups = new Map<string, KnowledgeNoteSummary[]>([['', []]])
  for (const folder of tree.folders) groups.set(folder, [])
  for (const note of tree.notes) {
    const folder = folderOf(note.path)
    groups.set(folder, [...(groups.get(folder) ?? []), note])
  }
  return [...groups.entries()]
    .filter(([folder, notes]) => folder !== '' || notes.length > 0 || tree.folders.length > 0)
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
}

export const filesInDrag = (event: { dataTransfer: DataTransfer }) =>
  event.dataTransfer.types.includes('Files')
