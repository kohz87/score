export const MAX_CSV_ROWS = 1000
export const MAX_CSV_COLUMNS = 100
export const MAX_CSV_CELLS = 20000

// Counts candidate delimiters in the first record only outside quoted fields (quoted newlines stay inside the record).
function detectDelimiter(source: string): string {
  const counts = { ',': 0, ';': 0, '\t': 0 }
  let quoted = false
  const end = Math.min(source.length, 65536)
  for (let at = 0; at < end; at += 1) {
    const char = source[at]!
    if (char === '"') quoted = !quoted
    else if (!quoted) {
      if (char === '\n' || char === '\r') break
      if (char in counts) counts[char as keyof typeof counts] += 1
    }
  }
  return counts['\t'] > counts[','] ? '\t' : counts[';'] > counts[','] ? ';' : ','
}

/**
 * Parses CSV (RFC 4180: quoted fields, doubled quotes, newlines inside quotes) into at most `maxRows` rows. Stops
 * reading at the limit so a huge file costs only what is shown. The delimiter is a comma, or a semicolon or tab
 * when the first line has more of those.
 */
export function parseCsv(
  text: string,
  maxRows = MAX_CSV_ROWS,
): { rows: string[][]; truncated: boolean } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const delimiter = detectDelimiter(source)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let truncated = false
  let cells = 0
  // Columns and total cells are bounded too, so a file of bare commas can't build a huge table.
  const pushField = () => {
    if (row.length < MAX_CSV_COLUMNS && cells < MAX_CSV_CELLS) {
      row.push(field)
      cells += 1
    } else truncated = true
    field = ''
  }
  const endRow = () => {
    pushField()
    rows.push(row)
    row = []
  }
  for (let at = 0; at < source.length; at += 1) {
    const char = source[at]!
    if (quoted) {
      if (char === '"') {
        if (source[at + 1] === '"') {
          field += '"'
          at += 1
        } else quoted = false
      } else field += char
      continue
    }
    if (char === '"' && field === '') quoted = true
    else if (char === delimiter) pushField()
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[at + 1] === '\n') at += 1
      endRow()
      if (rows.length >= maxRows) {
        truncated ||= at + 1 < source.length && source.slice(at + 1).trim() !== ''
        return { rows, truncated }
      }
      if (cells >= MAX_CSV_CELLS) {
        truncated ||= at + 1 < source.length && source.slice(at + 1).trim() !== ''
        return { rows, truncated }
      }
    } else if (field.length < 10000) field += char
  }
  if (field !== '' || row.length) endRow()
  return { rows, truncated }
}
