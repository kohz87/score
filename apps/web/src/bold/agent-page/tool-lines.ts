/** "A", "A and B", "A, B and C". */
export function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

/** One line for Reachable on: the connected channels, then the ones not connected ("Discord and Slack not connected"). */
export function channelLine(rows: { label: string; status: string }[]): string {
  const on = rows.filter((row) => row.status === 'connected').map((row) => row.label)
  const off = rows.filter((row) => row.status !== 'connected').map((row) => row.label)
  const parts = [on.length ? on.join(', ') : 'Nothing connected yet']
  if (off.length) parts.push(`${joinWords(off)} not connected`)
  return parts.join(' · ')
}

/** One line for Score access: Off, Read only, or Read and write. */
export function accessLine(access: { enabled: boolean; writesEnabled: boolean }): string {
  if (!access.enabled) return 'Off'
  return access.writesEnabled ? 'Read and write' : 'Read only'
}
