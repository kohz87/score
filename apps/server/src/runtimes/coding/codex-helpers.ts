// The pinned CLI's retry notice is `Reconnecting... n/m`, optionally followed by the reason for the retry. Nothing
// else counts, so a fatal message that merely mentions a retry stays loss (re-review 5 #1).
const RETRY_NOTICE = /^Reconnecting\.\.\. (\d+)\/(\d+)/
export function isRetryNotice(message: string): boolean {
  const match = RETRY_NOTICE.exec(message)
  if (!match) return false
  const n = Number(match[1])
  const m = Number(match[2])
  return n >= 1 && n <= m
}

/** Whether a decoded record says it is a completed or updated agent message, whatever else is wrong with it. */
export function claimsAgentMessage(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const { type, item } = value as { type?: unknown; item?: unknown }
  if (type !== 'item.completed' && type !== 'item.updated') return false
  return (
    typeof item === 'object' &&
    item !== null &&
    (item as { type?: unknown }).type === 'agent_message'
  )
}
