import { useId } from 'react'
import { useKnowledgeTree } from './knowledge-queries.ts'

/** A Knowledge folder: type a path (new folders are created) or pick an existing one. Mount only when needed. */
export function FolderPicker({
  value,
  onChange,
  label,
}: {
  value: string
  onChange: (folder: string) => void
  label: string
}) {
  const list = useId()
  const tree = useKnowledgeTree()
  const folders = [...new Set(['inbox', ...(tree.data?.folders ?? [])])].sort()
  return (
    <>
      <input
        className="kn-folder-input"
        aria-label={label}
        list={list}
        value={value}
        maxLength={500}
        placeholder="inbox"
        onChange={(event) => onChange(event.target.value.replace(/^\/+/, ''))}
      />
      <datalist id={list}>
        {folders.map((folder) => (
          <option key={folder} value={folder} />
        ))}
      </datalist>
    </>
  )
}
