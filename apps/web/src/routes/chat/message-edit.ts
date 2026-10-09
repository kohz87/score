import { useSyncExternalStore } from 'react'
import type { Message } from '@score/contract'
import { attachmentsOf, type Attachment } from './attachments.ts'

// Edit and resend (PLAN 5.24): "Edit" hands one of the person's messages to the composer; sending posts it as a new
// message with `edits`. The state lives here (not in the composer) because the action sits in the message list.
export interface Editing {
  roomId: string
  messageId: string
  text: string
  to: string[]
  attachments: Attachment[]
}

let editing: Editing | null = null
const listeners = new Set<() => void>()
function publish(next: Editing | null) {
  editing = next
  for (const listener of listeners) listener()
}

export function startEdit(message: Message): void {
  publish({
    roomId: message.roomId,
    messageId: message.id,
    text: message.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n\n'),
    to: message.to,
    attachments: attachmentsOf(message),
  })
}
export function stopEdit(): void {
  if (editing) publish(null)
}

export function useEditing(): Editing | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => editing,
  )
}
