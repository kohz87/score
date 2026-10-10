import type { KnowledgeDocumentSummary, KnowledgeNoteSummary, KnowledgeTree } from '@score/contract'

export const notePath = (path: string) =>
  path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
export const noteUrl = (path: string) => `/knowledge/${notePath(path)}`
export const apiNote = (path: string, tail = '') => `knowledge/notes/${notePath(path)}${tail}`

/** "a/b/Note.md" → "Note" */
export const baseName = (path: string) => (path.split('/').pop() ?? path).replace(/\.md$/i, '')
export const folderOf = (path: string) => path.split('/').slice(0, -1).join('/')

/** What the owner types in a prompt → a vault path: trims, drops leading slashes, adds `.md`. */
export function normalizeNewPath(input: string): string | null {
  const cleaned = input
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/')
  if (!cleaned || cleaned.endsWith('/')) return null
  return /\.md$/i.test(cleaned) ? cleaned : `${cleaned}.md`
}

/** The path a `[[Target#heading]]` link would create: the part before `#`, with `.md`. */
export function pathForLinkTarget(target: string): string {
  const name = target.split('#')[0]!.trim()
  return normalizeNewPath(name) ?? 'Untitled.md'
}

/** The text a `[[link]]` to this note should hold: the file name when unique, the full path otherwise. */
export function linkTargetFor(note: KnowledgeNoteSummary, notes: KnowledgeNoteSummary[]): string {
  const name = baseName(note.path)
  const same = notes.filter((n) => baseName(n.path).toLowerCase() === name.toLowerCase())
  return same.length > 1 ? note.path.replace(/\.md$/i, '') : name
}

export type TreeNode =
  | { kind: 'folder'; path: string; name: string; children: TreeNode[] }
  | { kind: 'note'; path: string; name: string; note: KnowledgeNoteSummary }
  | { kind: 'document'; path: string; name: string; document: KnowledgeDocumentSummary }

export function buildTree(tree: KnowledgeTree): TreeNode[] {
  const root: TreeNode[] = []
  const folders = new Map<string, Extract<TreeNode, { kind: 'folder' }>>()
  function folder(path: string): TreeNode[] {
    if (path === '') return root
    let node = folders.get(path)
    if (!node) {
      node = { kind: 'folder', path, name: path.split('/').pop()!, children: [] }
      folders.set(path, node)
      folder(folderOf(path)).push(node)
    }
    return node.children
  }
  for (const path of tree.folders) folder(path)
  for (const note of tree.notes)
    folder(folderOf(note.path)).push({
      kind: 'note',
      path: note.path,
      name: baseName(note.path),
      note,
    })
  for (const document of tree.documents)
    folder(folderOf(document.path)).push({
      kind: 'document',
      path: document.path,
      name: document.path.split('/').pop()!,
      document,
    })
  const sort = (nodes: TreeNode[]) => {
    nodes.sort(
      (a, b) =>
        (a.kind === b.kind || (a.kind !== 'folder' && b.kind !== 'folder')
          ? 0
          : a.kind === 'folder'
            ? -1
            : 1) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
    for (const node of nodes) if (node.kind === 'folder') sort(node.children)
  }
  sort(root)
  return root
}

export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}
