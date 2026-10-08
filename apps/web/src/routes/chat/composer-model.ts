import {
  CommandsResponseSchema,
  PostMessageResponseSchema,
  type CommandResult,
  type Message,
} from '@score/contract'

export type { CommandResult }
export type SlashCommand = { name: string; usage: string; description: string }
export type SendResult = { message: Message; routedTo: string[]; command: CommandResult | null }

export function parseCommands(payload: unknown): SlashCommand[] {
  return CommandsResponseSchema.parse(payload).items
}

export function parseSendResult(payload: unknown): SendResult {
  return PostMessageResponseSchema.parse(payload)
}

/** The word being typed after an `@` at the caret, or null. */
export function mentionAt(text: string, caret: number) {
  const match = /(^|\s)@([\w-]*)$/.exec(text.slice(0, caret))
  if (!match) return null
  const query = match[2]!
  return { start: caret - query.length - 1, query }
}

export function insertMention(text: string, caret: number, start: number, agentId: string) {
  const next = `${text.slice(0, start)}@${agentId} ${text.slice(caret)}`
  return { text: next, caret: start + agentId.length + 2 }
}

/** Slash menu is open while the first token starts with `/` and has no space yet. */
export function slashQuery(text: string) {
  const match = /^\/([\w-]*)$/.exec(text)
  return match ? match[1]!.toLowerCase() : null
}

const draftKey = (roomId: string) => `score.chat.draft.${roomId}`
export function loadDraft(roomId: string): string {
  try {
    return globalThis.localStorage.getItem(draftKey(roomId)) ?? ''
  } catch {
    return ''
  }
}
export function saveDraft(roomId: string, text: string) {
  try {
    if (text) globalThis.localStorage.setItem(draftKey(roomId), text)
    else globalThis.localStorage.removeItem(draftKey(roomId))
  } catch {
    // Storage can be blocked or full; the draft is a convenience only.
  }
}

/** Optimistic list updates: the pending message is replaced by the stored one, never duplicated. */
export function withMessage<T extends { items: Message[] }>(
  data: T,
  message: Message,
  replace?: string,
): T {
  const items = data.items.filter((item) => item.id !== replace && item.id !== message.id)
  return { ...data, items: [message, ...items] }
}
export function withoutMessage<T extends { items: Message[] }>(data: T, id: string): T {
  return { ...data, items: data.items.filter((item) => item.id !== id) }
}
