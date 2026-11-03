import type { Job } from '@score/contract'

export function chatDay(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** A default thread nobody wrote in is plumbing, not a chat: it stays out of the lists. */
export function listedChats(chats: readonly Job[]): Job[] {
  return chats.filter((chat) => !(chat.isDefault && chat.messageCount === 0))
}

export function matchesChat(chat: Job, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return `${chat.title}\n${chat.summary ?? ''}`.toLowerCase().includes(needle)
}

/**
 * The chat the composer writes into (3.22.0: a one-to-one is one conversation, its chats are topics): the one the
 * address names, else the newest chat that is still open, else the room's own thread.
 */
export function currentChat(chats: readonly Job[], chatId: string | null) {
  const picked = chatId ? chats.find((chat) => chat.id === chatId) : undefined
  const open = [...chats]
    .filter((chat) => !chat.isDefault && chat.state !== 'done' && chat.state !== 'closed')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]
  const current = picked ?? open ?? chats.find((chat) => chat.isDefault)
  return { picked, current }
}
