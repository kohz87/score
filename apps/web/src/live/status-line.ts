import type { MessagePart } from '@score/contract'

// PLAN 5.39: the one short line that says what a working agent is doing right now. Everything on screen that shows
// such a line (Now, Chat, Flow, the live diagrams) derives it here, from data Score already has.

/** Longest status line, counting the backticks around a tool name. */
export const STATUS_MAX = 60

export type StatusInput = {
  /** The agent has an open approval: Score is waiting for the person. */
  waitingForApproval?: boolean
  /** The agent's session is being compacted right now. */
  compacting?: boolean
  /** Parts of the reply being written, oldest first. */
  parts?: readonly MessagePart[]
  /** The `typing` stream event's text for the agent (fake mode), when there is one. */
  typing?: string | null
  /** The agent is working but nothing more specific is known. */
  working?: boolean
}

const CALLING = 'Calling '
const WRITING = 'Writing the reply…'

/** Trims to `max` characters with a single ellipsis character. */
export function trimLine(text: string, max = STATUS_MAX): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** "Calling `tool()`…", with the tool name cut (not the code-style marks) when the line would be too long. */
export function callingLine(tool: string, max = STATUS_MAX): string {
  const name = tool.trim()
  const room = max - (CALLING.length + '`()`…'.length)
  const shown = name.length <= room ? name : `${name.slice(0, Math.max(1, room - 1))}…`
  return `${CALLING}\`${shown}()\`…`
}

/**
 * Precedence: an open approval, then a compaction, then a running tool, then text being written, then reasoning.
 * Null when the agent is not working and nothing says otherwise.
 */
export function statusLine(input: StatusInput): string | null {
  if (input.waitingForApproval) return 'Waiting for your approval'
  if (input.compacting) return 'Compacting context…'
  const parts = input.parts ?? []
  const last = parts.findLast((part) => part.kind !== 'approval')
  const running = parts.findLast((part) => part.kind === 'tool' && part.status === 'running')
  if (running?.kind === 'tool') return callingLine(running.tool)
  if (last?.kind === 'text' && last.text.trim() !== '') return WRITING
  if (last?.kind === 'thinking') return 'Thinking…'
  if (input.typing) return WRITING
  if (input.working || parts.length > 0) return 'Thinking…'
  return null
}

/** The text split on the code-style marks of a tool name: odd entries are code. */
export function statusSegments(line: string): string[] {
  return line.split('`')
}
