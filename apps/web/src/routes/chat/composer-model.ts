import {
  CommandsResponseSchema,
  PostMessageResponseSchema,
  type CommandResult,
  type Message,
} from '@score/contract'

export type { CommandResult }
export type SlashCommand = {
  name: string
  usage: string
  description: string
  /** What picking it inserts, when that is more than `/name ` (the `/subagents` choices). */
  insert?: string
  /** A key for several palette rows with the same command name. */
  key?: string
  /** A note under the palette, explaining a group of choices. */
  note?: string
  /** A line above the palette, shown with the first item of a group (`/effort`'s "Effort for builder…"). */
  header?: string
}
export type SendResult = {
  message: Message
  routedTo: string[]
  command: CommandResult | null
  notices?: string[] | undefined
}

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

/**
 * `@agent /eff…` with `/effort` still being typed (decision 178): the palette is the effort choices for that agent, since
 * `@agent /effort <level>` is the only command addressed this way. Null for anything else.
 */
export function addressedEffortQuery(text: string) {
  const match = /^@([\w-]+)\s+\/([\w-]*)$/.exec(text)
  const query = match?.[2]?.toLowerCase()
  if (!match || query === undefined || !'effort'.startsWith(query)) return null
  return { agentId: match[1]!, query }
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
