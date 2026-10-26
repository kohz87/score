import type { Message } from '@score/contract'

// 2.4.0 Try another reply: replies written again for the same message share `alternativeOf` (the first reply's id).
// The stream shows such a group as one message at its first remaining member's place. Pure helpers, no React.

export type ReplyGroups = {
  /** Group members (oldest first) by the id of the member that carries the group, i.e. the first remaining one. */
  byHead: Map<string, Message[]>
  /** Members that are drawn inside another message's group, so the stream skips them. */
  folded: Set<string>
}

/** The id that ties a group together: the first reply's id (the first reply itself has no `alternativeOf`). */
export function groupKey(message: Message): string {
  return message.alternativeOf ?? message.id
}

/** `messages` oldest first. A group needs at least two members still on screen; a lone survivor is a plain message. */
export function groupReplies(messages: Message[]): ReplyGroups {
  const members = new Map<string, Message[]>()
  for (const message of messages) {
    if (message.author.kind !== 'agent') continue
    const key = groupKey(message)
    const list = members.get(key)
    if (list) list.push(message)
    else members.set(key, [message])
  }
  const byHead = new Map<string, Message[]>()
  const folded = new Set<string>()
  for (const list of members.values()) {
    if (list.length < 2) continue
    byHead.set(list[0]!.id, list)
    for (const message of list.slice(1)) folded.add(message.id)
  }
  return { byHead, folded }
}

/** A reply that ended without an answer (the server writes these notices): it keeps Retry, not Try another. */
export function isFailedReply(message: Message): boolean {
  if (message.author.kind !== 'agent' || message.streaming) return false
  const texts = message.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : []))
  if (texts.length !== 1 || message.parts.some((part) => part.kind !== 'text')) return false
  return /^This run (failed|was interrupted|was stopped)/.test(texts[0]!)
}

export const SWIPE_MIN = 48

/** -1 = previous version, 1 = next, 0 = not a version swipe (too short, or mostly vertical so scrolling wins). */
export function swipeStep(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) <= 2 * Math.abs(dy)) return 0
  return dx < 0 ? 1 : -1
}

const STORE = 'score.replyVersion.'

/** The version the viewer picked last for a group; storage may be missing or throw (private window), then null. */
export function readPickedVersion(key: string): string | null {
  try {
    return window.localStorage.getItem(STORE + key)
  } catch {
    return null
  }
}

export function writePickedVersion(key: string, messageId: string): void {
  try {
    window.localStorage.setItem(STORE + key, messageId)
  } catch {
    // The choice just isn't remembered.
  }
}
