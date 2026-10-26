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

/**
 * A reply that ended without an answer: the server appends its notice as the last text part (after any text or tool
 * parts the run produced). It keeps Retry, not Try another. "I ran out of steps…" is a finished answer.
 */
export function isFailedReply(message: Message): boolean {
  if (message.author.kind !== 'agent' || message.streaming) return false
  const last = message.parts.findLast((part) => part.kind === 'text')
  if (!last || last.kind !== 'text') return false
  return /^(This run (failed|was interrupted|was stopped)|Couldn['’]t start this agent)/.test(
    last.text.trim(),
  )
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

export function clearPickedVersion(key: string): void {
  try {
    window.localStorage.removeItem(STORE + key)
  } catch {
    // Nothing stored, nothing to clear.
  }
}

const PICK_EVENT = 'score:reply-version'

/** Selects a version of a group from outside it (a seek to a hidden version) and remembers the choice. */
export function pickReplyVersion(key: string, messageId: string): void {
  writePickedVersion(key, messageId)
  window.dispatchEvent(new CustomEvent(PICK_EVENT, { detail: { key, id: messageId } }))
}

export function onReplyVersionPicked(listener: (key: string, id: string) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ key: string; id: string }>).detail
    listener(detail.key, detail.id)
  }
  window.addEventListener(PICK_EVENT, handler)
  return () => window.removeEventListener(PICK_EVENT, handler)
}

/** Touches that begin on something that scrolls or acts on its own are never a version swipe. */
export function swipeBlockedBy(target: EventTarget | null, boundary: Element): boolean {
  let node = target instanceof Element ? target : null
  while (node) {
    if (node.matches('pre, code, table, button, a, input, textarea, select, [role="button"]'))
      return true
    if (node.scrollWidth > node.clientWidth + 1) {
      const overflow = window.getComputedStyle(node).overflowX
      if (overflow === 'auto' || overflow === 'scroll') return true
    }
    if (node === boundary) break
    node = node.parentElement
  }
  return false
}
