import type { WorkspaceEntry } from '@score/contract'
import { useTree, workspaceFailure } from './workspace-queries.ts'

export interface Selection {
  path: string
  kind: 'file' | 'dir'
}

export const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
export const parentOf = (path: string) => path.split('/').slice(0, -1).join('/')

function glyph(entry: WorkspaceEntry, open: boolean) {
  if (entry.kind === 'dir') return open ? '▾' : '▸'
  return entry.kind === 'symlink' ? '↗' : '·'
}

/** One folder level; children load only when the folder is opened. */
export function TreeLevel({
  agentId,
  path,
  depth,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  agentId: string
  path: string
  depth: number
  expanded: ReadonlySet<string>
  selected: Selection | null
  onToggle: (path: string) => void
  onSelect: (selection: Selection) => void
}) {
  const tree = useTree(agentId, path)
  if (tree.isPending)
    return (
      <p className="ws-note" role="status">
        Loading…
      </p>
    )
  if (tree.isError)
    return (
      <p className="ws-note" role="alert">
        {workspaceFailure(tree.error, 'list this folder')}{' '}
        <button type="button" onClick={() => void tree.refetch()}>
          Try again
        </button>
      </p>
    )
  if (!tree.data.length)
    return (
      <p className="ws-note ws-empty" style={{ paddingLeft: 12 + depth * 16 }}>
        Empty folder
      </p>
    )
  return (
    <ul
      className="ws-level"
      role={depth === 0 ? 'tree' : 'group'}
      aria-label={depth === 0 ? 'Files' : undefined}
    >
      {tree.data.map((entry) => {
        const entryPath = join(path, entry.name)
        const isDir = entry.kind === 'dir'
        const open = isDir && expanded.has(entryPath)
        const isSelected = selected?.path === entryPath
        return (
          <li key={entry.name} role="none">
            <button
              type="button"
              role="treeitem"
              className={`ws-row${isSelected ? ' is-selected' : ''}${entry.hidden ? ' is-hidden' : ''}`}
              style={{ paddingLeft: 12 + depth * 16 }}
              aria-selected={isSelected}
              {...(isDir ? { 'aria-expanded': open } : {})}
              onClick={() => {
                if (isDir) onToggle(entryPath)
                onSelect({ path: entryPath, kind: isDir ? 'dir' : 'file' })
              }}
            >
              <span className="ws-glyph" aria-hidden="true">
                {glyph(entry, open)}
              </span>
              <span className="ws-name">{entry.name}</span>
              {entry.kind === 'symlink' && <span className="ws-tag">link</span>}
            </button>
            {open && (
              <TreeLevel
                agentId={agentId}
                path={entryPath}
                depth={depth + 1}
                expanded={expanded}
                selected={selected}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}
