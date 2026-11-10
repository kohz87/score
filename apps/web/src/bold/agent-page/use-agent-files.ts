import { useState } from 'react'

/**
 * The Files panel under Work: closed until a workspace link (`?path=`, from the chat or the Workbench) asks for it.
 * A link to another file while the page is already open follows the link.
 */
export function useAgentFiles(initialPath: string | null) {
  const [files, setFiles] = useState<{ path: string | null } | null>(
    initialPath === null ? null : { path: initialPath },
  )
  const [seen, setSeen] = useState(initialPath)
  if (seen !== initialPath) {
    setSeen(initialPath)
    if (initialPath !== null) setFiles({ path: initialPath })
  }
  return { files, close: () => setFiles(null) }
}
