import { redact } from '../../redact.ts'
import type { ToolDetail } from './types.ts'

/** `system/<subtype>` when the subtype is a plain identifier, else `system`; "after the result" when it came late. */
export function systemKind(value: unknown, late: boolean): string {
  const subtype = (value as { subtype?: unknown } | null)?.subtype
  const name =
    typeof subtype === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(subtype)
      ? `system/${subtype}`
      : 'system'
  return late ? `${name}, after the result` : name
}

// Only `completed` is a clean end; a status Score has not seen reads as failed for the sub-agent (visible, not the turn).
export const subStatus = (status: string): 'running' | 'done' | 'failed' =>
  status === 'completed'
    ? 'done'
    : status === 'running' || status === 'pending'
      ? 'running'
      : 'failed'

const PATH_KEYS = ['file_path', 'path', 'notebook_path']
export function preview(tool: string, input: unknown): string {
  if (input === null || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  const pick = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : null)
  if (tool === 'Bash') return pick('command') ?? ''
  // A sub-agent's card says what it was asked to do, in a few words, not the whole prompt (PLAN 8.7).
  if (tool === 'Agent' || tool === 'Task') {
    const description = pick('description')
    if (description) return description
  }
  for (const key of [...PATH_KEYS, 'pattern', 'url', 'query']) {
    const value = pick(key)
    if (value) return value
  }
  try {
    // Redact before the cut: a clipped label would leave its value unrecognisable.
    return redact(JSON.stringify(input)).slice(0, 300)
  } catch {
    return ''
  }
}

export function detail(
  tool: string,
  input: unknown,
  cwd: string | undefined,
): ToolDetail | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  const str = (key: string) =>
    typeof record[key] === 'string' ? (record[key] as string) : undefined
  if (tool === 'Bash') {
    const command = str('command')
    return command === undefined ? undefined : { type: 'command', command, ...(cwd ? { cwd } : {}) }
  }
  const path = str('file_path')
  if (tool === 'Write' && path !== undefined && str('content') !== undefined)
    return { type: 'write', path, content: str('content')! }
  if (tool === 'Edit' && path !== undefined && str('old_string') !== undefined)
    return {
      type: 'replace',
      path,
      oldString: str('old_string')!,
      newString: str('new_string') ?? '',
    }
  return undefined
}

export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as { text?: unknown }).text === 'string'
          ? (item as { text: string }).text
          : '',
      )
      .join('')
  return ''
}
