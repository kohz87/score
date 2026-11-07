import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { Attachment } from './attachments.ts'
import type { Notice } from './composer-types.ts'
import { stopEdit, useEditing } from './message-edit.ts'

export type EditStash = { text: string; to: string[]; attachments: Attachment[] }

export function useComposerEditing({
  roomId,
  text,
  to,
  attachments,
  setText,
  setCaret,
  setTo,
  setAttachments,
  setPlanFirst,
  setNotice,
  textarea,
}: {
  roomId: string
  text: string
  to: string[]
  attachments: Attachment[]
  setText: Dispatch<SetStateAction<string>>
  setCaret: Dispatch<SetStateAction<number>>
  setTo: Dispatch<SetStateAction<string[]>>
  setAttachments: Dispatch<SetStateAction<Attachment[]>>
  setPlanFirst: Dispatch<SetStateAction<boolean>>
  setNotice: Dispatch<SetStateAction<Notice | null>>
  textarea: { current: HTMLTextAreaElement | null }
}) {
  // Edit and resend: the message loads into the composer; what was there before comes back afterwards.
  const editingNow = useEditing()
  const editing = editingNow?.roomId === roomId ? editingNow : null
  const editId = editing?.messageId ?? null
  const [stash, setStash] = useState<EditStash | null>(null)
  const [loadedEdit, setLoadedEdit] = useState<string | null>(null)
  if (editId !== loadedEdit) {
    // Adjusting state while rendering: only a different message reloads the composer.
    setLoadedEdit(editId)
    if (editing) {
      setStash((saved) => saved ?? { text, to, attachments })
      setText(editing.text)
      setCaret(editing.text.length)
      setTo(editing.to)
      setAttachments(editing.attachments)
      setPlanFirst(false)
      setNotice(null)
    }
  }
  // Counts edit sessions, so a response can tell whether the edit it belongs to is still the one on screen.
  const editSession = useRef(0)
  useEffect(() => {
    editSession.current += 1
    if (editId) textarea.current?.focus()
  }, [editId, textarea])
  const rewoundEdit = useRef<string | null>(null)
  // One rewind request per edited message, so a retried Send can't rewind twice.
  const rewindKey = useRef<{ messageId: string; key: string } | null>(null)
  const [rewinding, setRewinding] = useState(false)
  function leaveEdit() {
    // A rewind that never confirmed is planned again by the next edit; one that happened stays done.
    if (rewindKey.current && rewoundEdit.current !== rewindKey.current.messageId)
      rewindKey.current = null
    stopEdit()
    setLoadedEdit(null)
    if (!stash) return
    setText(stash.text)
    setCaret(stash.text.length)
    setTo(stash.to)
    setAttachments(stash.attachments)
    setStash(null)
  }
  function markRewound(messageId: string) {
    rewoundEdit.current = messageId
  }
  useEffect(() => () => stopEdit(), [])
  // The message whose rewind already happened: a failed send is retried without asking again.
  const [confirmEdit, setConfirmEdit] = useState(false)

  return {
    editing,
    editId,
    stash,
    setStash,
    editSession,
    rewoundEdit,
    rewindKey,
    rewinding,
    setRewinding,
    leaveEdit,
    markRewound,
    confirmEdit,
    setConfirmEdit,
    setLoadedEdit,
  }
}
