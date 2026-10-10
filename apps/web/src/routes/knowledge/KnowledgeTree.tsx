import { useMemo, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import type { KnowledgeTree as Tree } from '@score/contract'
import { TYPE_LABEL } from './knowledge-files.ts'
import { buildTree, folderOf, noteUrl, type TreeNode } from './knowledge-paths.ts'

type Row = { node: TreeNode; depth: number }

function rows(nodes: TreeNode[], open: Set<string>, depth = 0): Row[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.kind === 'folder' && open.has(node.path) ? rows(node.children, open, depth + 1) : []),
  ])
}

function ancestors(path: string): string[] {
  const parts = folderOf(path).split('/').filter(Boolean)
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

/** An ARIA tree with roving focus: arrows move, Right/Left open and close folders, Enter opens a note. */
export function KnowledgeTree({
  tree,
  current,
  onDropFiles,
}: {
  tree: Tree
  current: string | null
  /** Files dropped on a folder row (or on empty space, folder ''). */
  onDropFiles?: (files: File[], folder: string) => void
}) {
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const navigate = useNavigate()
  const roots = useMemo(() => buildTree(tree), [tree])
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [focused, setFocused] = useState<string | null>(null)
  const open = useMemo(() => {
    const all = new Set(tree.folders)
    for (const note of tree.notes) for (const folder of ancestors(note.path)) all.add(folder)
    for (const document of tree.documents)
      for (const folder of ancestors(document.path)) all.add(folder)
    for (const path of closed) all.delete(path)
    // The open note's folders always show it.
    if (current) for (const folder of ancestors(current)) all.add(folder)
    return all
  }, [tree, closed, current])
  const visible = useMemo(() => rows(roots, open), [roots, open])
  const tabStop =
    visible.find((row) => row.node.path === focused)?.node.path ??
    visible.find((row) => row.node.path === current)?.node.path ??
    visible[0]?.node.path

  function toggle(path: string, to: boolean) {
    setClosed((previous) => {
      const next = new Set(previous)
      if (to) next.delete(path)
      else next.add(path)
      return next
    })
  }
  function focusRow(path: string | undefined) {
    if (!path) return
    setFocused(path)
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-kn-path="${CSS.escape(path)}"]`)?.focus(),
    )
  }
  function onKeyDown(event: KeyboardEvent<HTMLElement>, row: Row, index: number) {
    const { node } = row
    if (event.key === 'ArrowDown') focusRow(visible[index + 1]?.node.path)
    else if (event.key === 'ArrowUp') focusRow(visible[index - 1]?.node.path)
    else if (event.key === 'Home') focusRow(visible[0]?.node.path)
    else if (event.key === 'End') focusRow(visible[visible.length - 1]?.node.path)
    else if (event.key === 'ArrowRight' && node.kind === 'folder') {
      if (!open.has(node.path)) toggle(node.path, true)
      else focusRow(visible[index + 1]?.node.path)
    } else if (event.key === 'ArrowLeft') {
      if (node.kind === 'folder' && open.has(node.path)) toggle(node.path, false)
      else focusRow(folderOf(node.path) || undefined)
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (node.kind === 'folder') toggle(node.path, !open.has(node.path))
      else void navigate(noteUrl(node.path))
    } else return
    event.preventDefault()
  }

  if (visible.length === 0)
    return (
      <p className="kn-muted">No notes or files yet. Press Ctrl+N to write one, or upload files.</p>
    )
  return (
    <ul role="tree" aria-label="Notes" className="kn-tree">
      {visible.map((row, index) => {
        const { node, depth } = row
        const isOpen = node.kind === 'folder' && open.has(node.path)
        return (
          <li
            key={`${node.kind}:${node.path}`}
            role="treeitem"
            tabIndex={node.path === tabStop ? 0 : -1}
            data-kn-path={node.path}
            aria-level={depth + 1}
            aria-expanded={node.kind === 'folder' ? isOpen : undefined}
            aria-selected={node.kind !== 'folder' ? node.path === current : undefined}
            className={`kn-tree-row${node.path === current ? ' is-current' : ''}${dropTarget === node.path ? ' is-drop' : ''}`}
            onDragOver={(event) => {
              if (!onDropFiles || !event.dataTransfer.types.includes('Files')) return
              event.preventDefault()
              event.stopPropagation()
              setDropTarget(node.kind === 'folder' ? node.path : folderOf(node.path))
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(event) => {
              if (!onDropFiles || !event.dataTransfer.types.includes('Files')) return
              event.preventDefault()
              event.stopPropagation()
              setDropTarget(null)
              onDropFiles(
                [...event.dataTransfer.files],
                node.kind === 'folder' ? node.path : folderOf(node.path),
              )
            }}
            style={{ paddingLeft: 10 + depth * 16 }}
            onFocus={() => setFocused(node.path)}
            onKeyDown={(event) => onKeyDown(event, row, index)}
            onClick={() => {
              if (node.kind === 'folder') toggle(node.path, !isOpen)
              else void navigate(noteUrl(node.path))
            }}
          >
            <span aria-hidden="true" className="kn-tree-mark">
              {node.kind === 'folder' ? (isOpen ? '▾' : '▸') : '•'}
            </span>
            {node.name}
            {node.kind === 'document' && (
              <span className="kn-type-badge">{TYPE_LABEL[node.document.type]}</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
