export const MAX_CSV_ROWS = 1000

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
  const firstLine = source.split(/\r?\n/, 1)[0] ?? ''
  const count = (char: string) => firstLine.split(char).length - 1
  const delimiter = count('\t') > count(',') ? '\t' : count(';') > count(',') ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let truncated = false
  const endRow = () => {
    row.push(field)
    field = ''
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
    else if (char === delimiter) {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[at + 1] === '\n') at += 1
      endRow()
      if (rows.length >= maxRows) {
        truncated = at + 1 < source.length && source.slice(at + 1).trim() !== ''
        return { rows, truncated }
      }
    } else field += char
  }
  if (field !== '' || row.length) endRow()
  return { rows, truncated }
}
