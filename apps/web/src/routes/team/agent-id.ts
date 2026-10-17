// Agent ids are Hermes profile names: lowercase letters, digits, - and _ (ProfileNameSchema).

/**
 * For an input's `pattern`, which browsers compile with the `v` flag: there an unescaped `-` in a class is a syntax
 * error and the browser silently drops the check (it let "Luna" through to a generic server error, 2026-10-17).
 */
export const AGENT_ID_PATTERN = '[a-z0-9][a-z0-9_\\-]{0,63}'

/** What the person typed, as an id: lowercase, spaces as dashes (phones capitalise the first letter). */
export function agentIdInput(typed: string): string {
  return typed.toLowerCase().replace(/\s+/g, '-')
}
