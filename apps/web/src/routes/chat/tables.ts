const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/
const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

/** A GFM separator row (a `---` line without a pipe is a rule, not a table). */
const separator = (line: string) => line.includes('|') && SEPARATOR.test(line)

/**
 * The cells of a pipe row, or null. Not a row: indented code, a quote, a bullet item, inline code or an escaped pipe
 * (their pipes aren't column borders), a separator, or a line with an empty cell.
 */
function cells(line: string): string[] | null {
  if (separator(line) || /^( {4}|\t)|^\s*(>|[-*+]\s)/.test(line) || /`|\\\|/.test(line)) return null
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  if (!inner.includes('|')) return null
  const parts = inner.split('|').map((cell) => cell.trim())
  return parts.every((cell) => cell.length > 0) ? parts : null
}

/**
 * 3.7.11: a table written without its separator row ("Card | Proposed version | Why" over a few rows, as models told to
 * "assume plain text" write it) becomes a Markdown table. Only runs of three or more lines with the same number of
 * cells, at least two each, outside fenced code; a run that already has a separator row is a table as it stands.
 */
export function normalizeTables(text: string): string {
  if (!text.includes('|')) return text
  const lines = text.split('\n')
  const out: string[] = []
  let fence: string | null = null
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!
    const open = FENCE.exec(line)
    if (open) {
      const marker = open[1]!
      if (fence === null) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      out.push(line)
      i++
      continue
    }
    // A real table: its separator row and every row under it stay as written.
    if (fence === null && separator(line)) {
      out.push(line)
      i++
      while (i < lines.length && cells(lines[i]!)) out.push(lines[i++]!)
      continue
    }
    const first = fence === null ? cells(line) : null
    if (!first) {
      out.push(line)
      i++
      continue
    }
    let end = i + 1
    while (end < lines.length && cells(lines[end]!)?.length === first.length) end++
    // A header row followed by a separator is a real table's header.
    const separated = end < lines.length && separator(lines[end]!)
    if (end - i < 3 || separated) {
      out.push(line)
      i++
      continue
    }
    if (out.length && out.at(-1)!.trim() !== '') out.push('')
    const rows = lines.slice(i, end).map((row) => `| ${cells(row)!.join(' | ')} |`)
    out.push(rows[0]!, `| ${first.map(() => '---').join(' | ')} |`, ...rows.slice(1))
    if (end < lines.length && lines[end]!.trim() !== '') out.push('')
    i = end
  }
  return out.join('\n')
}
