import { useId } from 'react'
import { FolderPicker } from './FolderPicker.tsx'

/** On a composer attachment chip: "Also save to Knowledge" (off by default) with a folder (default inbox). */
export function ChipSaveOption({
  name,
  folder,
  onChange,
}: {
  name: string
  /** null = off. */
  folder: string | null
  onChange: (folder: string | null) => void
}) {
  const id = useId()
  return (
    <span className="chat-attachment-save">
      <label htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={folder !== null}
          aria-label={`Also save ${name} to Knowledge`}
          onChange={(event) => onChange(event.target.checked ? 'inbox' : null)}
        />
        <span>Also save to Knowledge</span>
      </label>
      {folder !== null && (
        <FolderPicker value={folder} onChange={onChange} label={`Knowledge folder for ${name}`} />
      )}
    </span>
  )
}
