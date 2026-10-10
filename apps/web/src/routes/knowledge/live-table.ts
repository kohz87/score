export type ParsedTable = {
  header: string[]
  align: (('left' | 'center' | 'right') | null)[]
  rows: string[][]
}

/** Splits one GFM table row on unescaped pipes that are not inside backticks. */
export function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  const cells: string[] = []
  let current = ''
  let code = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (char === '\\' && text[index + 1] === '|') {
      current += '|'
      index += 1
    } else if (char === '`') {
      code = !code
      current += char
    } else if (char === '|' && !code) {
      cells.push(current.trim())
      current = ''
    } else current += char
  }
  cells.push(current.trim())
  return cells
}

/** Reads the source of a Table node (header, delimiter row, body rows); null when it is not a table after all. */
export function parseTable(source: string): ParsedTable | null {
  const lines = source.split('\n').filter((line) => line.trim() !== '')
  if (lines.length < 2) return null
  const header = splitRow(lines[0]!)
  const delimiter = splitRow(lines[1]!)
  if (!delimiter.every((cell) => /^:?-+:?$/.test(cell))) return null
  const align = header.map((_cell, index) => {
    const spec = delimiter[index] ?? ''
    if (spec.startsWith(':') && spec.endsWith(':')) return 'center' as const
    if (spec.endsWith(':')) return 'right' as const
    if (spec.startsWith(':')) return 'left' as const
    return null
  })
  return { header, align, rows: lines.slice(2).map(splitRow) }
}

type InlineHooks = { isMissing: (target: string) => boolean }

const INLINE =
  /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|~~([^~]+)~~|\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]|\[([^\]]+)\]\(([^)\s]+)\)/g

/** Appends the cell's inline Markdown as DOM nodes (never innerHTML, so nothing in a note can inject markup). */
export function renderInline(parent: HTMLElement, text: string, hooks: InlineHooks): void {
  let last = 0
  for (const found of text.matchAll(INLINE)) {
    if (found.index > last) parent.append(text.slice(last, found.index))
    last = found.index + found[0].length
    if (found[1] !== undefined) {
      const code = document.createElement('code')
      code.textContent = found[1]
      parent.append(code)
    } else if (found[2] !== undefined || found[3] !== undefined) {
      const strong = document.createElement('strong')
      renderInline(strong, (found[2] ?? found[3])!, hooks)
      parent.append(strong)
    } else if (found[4] !== undefined) {
      const em = document.createElement('em')
      renderInline(em, found[4], hooks)
      parent.append(em)
    } else if (found[5] !== undefined) {
      const del = document.createElement('del')
      renderInline(del, found[5], hooks)
      parent.append(del)
    } else if (found[6] !== undefined) {
      const target = found[6].trim()
      const span = document.createElement('span')
      span.className = `cm-lp-wikilink${hooks.isMissing(target) ? ' is-missing' : ''}`
      span.dataset.wikilink = target
      span.textContent = found[7] ?? found[6]
      parent.append(span)
    } else if (found[8] !== undefined) {
      const href = found[9]!
      if (/^(https?:|mailto:)/i.test(href)) {
        const anchor = document.createElement('a')
        anchor.href = href
        anchor.target = '_blank'
        anchor.rel = 'noopener noreferrer'
        anchor.textContent = found[8]
        parent.append(anchor)
      } else parent.append(found[8])
    }
  }
  if (last < text.length) parent.append(text.slice(last))
}
