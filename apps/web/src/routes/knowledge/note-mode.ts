const KEY = 'score.knowledge.source'

/** Whether this device last used Source (plain Markdown) instead of the live editor. */
export function readSource(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    // Storage can be blocked; the live editor is the default.
    return false
  }
}

export function writeSource(source: boolean): void {
  try {
    if (source) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {
    // Not remembered; nothing else depends on it.
  }
}
