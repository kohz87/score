// "Click a member of the room stage to mention it" (PLAN 10.10): the stage asks, the composer of that room answers.

/** The text with `@id ` inserted at the caret (a space before it when the text before needs one) and the new caret. */
export function mentionInsertion(
  text: string,
  caret: number,
  agentId: string,
): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length))
  const before = text.slice(0, at)
  const after = text.slice(at)
  const lead = before !== '' && !/\s$/.test(before) ? ' ' : ''
  // Text that already continues with a space keeps it as the separator.
  const space = /^\s/.test(after) ? '' : ' '
  const inserted = `${lead}@${agentId}${space}`
  return {
    text: before + inserted + after,
    caret: at + inserted.length + (space === '' ? 1 : 0),
  }
}

const EVENT = 'score:mention'

export function requestMention(roomId: string, agentId: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { roomId, agentId } }))
}

/** Calls `handler` for each request aimed at this room; returns the cleanup. */
export function onMention(roomId: string, handler: (agentId: string) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ roomId: string; agentId: string }>).detail
    if (detail.roomId === roomId) handler(detail.agentId)
  }
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
