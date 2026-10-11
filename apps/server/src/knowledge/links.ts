import path from 'node:path'

// Wikilinks (contract §12): extraction, Obsidian-style resolution and rewriting. Pure; no I/O.
// Resolution ideas follow the owner's Artemis vault server (packages/vault-server), reimplemented.

export interface ParsedLink {
  /** As written, minus the alias: `Target`, `Target#heading`. */
  target: string
  /** Offsets of the whole `[[…]]` in the text it was found in. */
  start: number
  end: number
  alias: string | null
}

type Range = [number, number]

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const LIST_MARKER = /^([-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const THEMATIC = /^([-*_])(?:[ \t]*\1){2,}[ \t]*\r?$/
const SETEXT = /^(?:=+|-+)[ \t]*\r?$/
const ATX = /^#{1,6}(?:[ \t]|$)/

/** A fence opener (a backtick fence's info string cannot contain a backtick), or null. */
function fenceOpening(line: string): { char: string; length: number } | null {
  const open = FENCE_OPEN.exec(line)
  if (!open || (open[1]![0] === '`' && open[2]!.includes('`'))) return null
  return { char: open[1]![0]!, length: open[1]!.length }
}

type Container = { kind: 'quote' } | { kind: 'list'; indent: number; empty: boolean }

/** Leading blanks from `pos` (a tab counts to the next multiple of four): columns and the position after them. */
function leading(
  line: string,
  pos: number,
  col: number,
): { cols: number; pos: number; col: number } {
  let p = pos
  let c = col
  for (; p < line.length; p++) {
    const char = line[p]
    if (char === ' ') c++
    else if (char === '\t') c += 4 - (c % 4)
    else break
  }
  return { cols: c - col, pos: p, col: c }
}

/** Moves over blanks until `columns` have been passed (a tab that straddles the end is consumed whole). */
function skipColumns(line: string, pos: number, col: number, columns: number) {
  let p = pos
  let c = col
  while (p < line.length && c - col < columns) {
    const char = line[p]
    if (char === ' ') c++
    else if (char === '\t') c += 4 - (c % 4)
    else break
    p++
  }
  return { pos: p, col: c }
}

interface Blocks {
  ranges: Range[]
  lineStarts: number[]
  /** Paragraph number per line (every line outside a paragraph has a number of its own). */
  lineParagraphs: number[]
}

/**
 * Block-level literals (CommonMark): fenced code (opened by 3+ backticks or tildes, indented up to 3 spaces; closed
 * by the same character, at least as long, nothing else on the line; it ends with its container) and indented code
 * (4+ columns after a blank line or at the start; it cannot interrupt a paragraph). Containers are tracked as a
 * stack, per line: blockquote markers (`>`), and list items (`-`, `*`, `+`, `1.`, `1)`) whose content indent is the
 * marker width plus the spaces after it. A line that doesn't continue a container closes it, unless it is a lazy
 * paragraph continuation. One pass, linear in the text.
 */
function scanBlocks(text: string): Blocks {
  const ranges: Range[] = []
  const lineStarts: number[] = []
  const lineParagraphs: number[] = []
  const stack: Container[] = []
  let fence: { char: string; length: number; start: number; end: number } | null = null
  let indented: { start: number; end: number } | null = null
  let paragraph = false
  let paragraphId = 0
  let offset = 0
  const flushIndented = () => {
    if (indented) ranges.push([indented.start, indented.end])
    indented = null
  }
  const closeFence = () => {
    if (fence) ranges.push([fence.start, fence.end])
    fence = null
  }
  const own = () => ++paragraphId

  for (const line of text.split('\n')) {
    const lineStart = offset
    const lineEnd = offset + line.length
    offset = lineEnd + 1
    lineStarts.push(lineStart)

    // 1. Which open containers does this line continue?
    let pos = 0
    let col = 0
    let matched = 0
    for (; matched < stack.length; matched++) {
      const container = stack[matched]!
      if (container.kind === 'quote') {
        const lead = leading(line, pos, col)
        if (lead.cols > 3 || line[lead.pos] !== '>') break
        pos = lead.pos + 1
        col = lead.col + 1
        if (line[pos] === ' ') {
          pos++
          col++
        } else if (line[pos] === '\t') {
          col += 4 - (col % 4)
          pos++
        }
      } else if (line.slice(pos).trim() !== '') {
        const lead = leading(line, pos, col)
        if (lead.cols < container.indent) break
        ;({ pos, col } = skipColumns(line, pos, col, container.indent))
        container.empty = false
      } else if (container.empty) {
        break // an item can start with one blank line at most
      }
    }

    // 2. An open fence takes every line of its containers, and ends with them.
    if (fence) {
      if (matched === stack.length) {
        fence.end = lineEnd
        const close = new RegExp(`^ {0,3}${fence.char}{${fence.length},}[ \\t]*\\r?$`)
        lineParagraphs.push(own())
        if (close.test(line.slice(pos))) {
          closeFence()
          paragraph = false
        }
        continue
      }
      closeFence()
      paragraph = false
    }

    // 3. New containers opening on this line.
    const opened: Container[] = []
    for (;;) {
      const lead = leading(line, pos, col)
      if (lead.cols > 3) break
      const char = line[lead.pos]
      if (char === '>') {
        opened.push({ kind: 'quote' })
        pos = lead.pos + 1
        col = lead.col + 1
        if (line[pos] === ' ') {
          pos++
          col++
        } else if (line[pos] === '\t') {
          col += 4 - (col % 4)
          pos++
        }
        continue
      }
      const marker = LIST_MARKER.exec(line.slice(lead.pos, lead.pos + 12))
      if (!marker) break
      if (THEMATIC.test(line.slice(lead.pos))) break
      const after = lead.pos + marker[1]!.length
      const empty = line.slice(after).trim() === ''
      // Only a non-empty item, or an ordered one starting at 1, may interrupt a paragraph.
      if (paragraph && matched === stack.length && opened.length === 0) {
        if (empty) break
        if (/^\d/.test(marker[1]!) && Number.parseInt(marker[1]!, 10) !== 1) break
      }
      const spaces = leading(line, after, lead.col + marker[1]!.length)
      const width = empty || spaces.cols > 4 ? 1 : spaces.cols
      opened.push({ kind: 'list', indent: lead.cols + marker[1]!.length + width, empty })
      ;({ pos, col } = skipColumns(line, after, lead.col + marker[1]!.length, width))
      continue
    }
    const rest = line.slice(pos)
    const blank = rest.trim() === ''
    const lead = leading(line, pos, col)
    if (opened.length > 0) {
      stack.length = matched
      flushIndented()
      stack.push(...opened)
      paragraph = false
    } else if (matched < stack.length) {
      const body = rest.slice(lead.pos - pos)
      const interrupts =
        blank ||
        (lead.cols < 4 && (fenceOpening(rest) !== null || THEMATIC.test(body) || ATX.test(body)))
      if (paragraph && !interrupts) {
        lineParagraphs.push(paragraphId) // lazy continuation
        continue
      }
      stack.length = matched
      flushIndented()
      paragraph = false
    }

    // 4. The leaf the rest of the line belongs to.
    if (blank) {
      paragraph = false
      lineParagraphs.push(own())
      continue
    }
    const text2 = rest.slice(lead.pos - pos)
    const open = fenceOpening(rest)
    if (lead.cols < 4 && open) {
      flushIndented()
      fence = { char: open.char, length: open.length, start: lineStart, end: lineEnd }
      paragraph = false
      lineParagraphs.push(own())
      continue
    }
    if (lead.cols >= 4 && !paragraph) {
      indented ??= { start: lineStart, end: lineEnd }
      indented.end = lineEnd
      lineParagraphs.push(own())
      continue
    }
    flushIndented()
    if (paragraph && lead.cols < 4 && SETEXT.test(text2)) {
      paragraph = false // the underline ends the heading it belongs to
      lineParagraphs.push(paragraphId)
      continue
    }
    if (lead.cols < 4 && (ATX.test(text2) || THEMATIC.test(text2))) {
      paragraph = false
      lineParagraphs.push(own())
      continue
    }
    if (!paragraph) {
      paragraph = true
      own()
    }
    lineParagraphs.push(paragraphId)
  }
  closeFence()
  flushIndented()
  return { ranges, lineStarts, lineParagraphs }
}

interface BacktickRun {
  start: number
  length: number
  /** An odd number of backslashes directly before it: its first backtick is literal outside code. */
  escaped: boolean
}

/** Ranges (sorted, disjoint) of fenced and indented code blocks and inline code spans, which never contain links. */
export function codeRanges(text: string): Array<[number, number]> {
  const { ranges: blocks, lineStarts, lineParagraphs } = scanBlocks(text)
  const inBlock = (position: number): boolean => inRanges(blocks, position)
  // Inline code: a run of N backticks closes at the next run of exactly N in the same paragraph. A backslash
  // before the opening backtick makes it literal (backslashes do not escape inside code).
  const runs: BacktickRun[] = []
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '`') continue
    if (inBlock(index)) continue
    let end = index
    while (text[end] === '`') end++
    let slashes = 0
    while (index - slashes - 1 >= 0 && text[index - slashes - 1] === '\\') slashes++
    runs.push({ start: index, length: end - index, escaped: slashes % 2 === 1 })
    index = end - 1
  }
  // Bucket positions are appended in place: copying them per run made many short spans quadratic.
  const byLength = new Map<number, number[]>()
  runs.forEach((run, position) => {
    const bucket = byLength.get(run.length)
    if (bucket === undefined) byLength.set(run.length, [position])
    else bucket.push(position)
  })
  const paragraphOf = (position: number): number => {
    let low = 0
    let high = lineStarts.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (lineStarts[mid]! <= position) low = mid + 1
      else high = mid
    }
    return lineParagraphs[low - 1] ?? -1
  }
  const spans: Range[] = []
  for (let k = 0; k < runs.length; k++) {
    const opener = runs[k]!
    const length = opener.escaped ? opener.length - 1 : opener.length
    if (length === 0) continue
    const start = opener.escaped ? opener.start + 1 : opener.start
    const candidates = byLength.get(length) ?? []
    // First same-length run after the opener (binary search over positions).
    let low = 0
    let high = candidates.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (candidates[mid]! <= k) low = mid + 1
      else high = mid
    }
    const closer = candidates[low] === undefined ? undefined : runs[candidates[low]!]
    if (closer === undefined || paragraphOf(closer.start) !== paragraphOf(start)) continue
    spans.push([start, closer.start + closer.length])
    k = candidates[low]!
  }
  const merged: Range[] = []
  for (const range of [...blocks, ...spans].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([range[0], range[1]])
  }
  return merged
}

function inRanges(ranges: Range[], position: number): boolean {
  let low = 0
  let high = ranges.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (ranges[mid]![1] <= position) low = mid + 1
    else high = mid
  }
  return low < ranges.length && ranges[low]![0] <= position
}

export function parseWikilinks(text: string): ParsedLink[] {
  const code = codeRanges(text)
  const links: ParsedLink[] = []
  for (const match of text.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
    const start = match.index
    if (inRanges(code, start)) continue
    // `\[[Target]]` is literal text; `\\[[Target]]` is an escaped backslash and then a link.
    let slashes = 0
    while (
      start - slashes - 1 >= 0 &&
      text[start - slashes - 1] === '\\' &&
      !inRanges(code, start - slashes - 1)
    )
      slashes++
    if (slashes % 2 === 1) continue
    const inner = match[1]!
    const bar = inner.indexOf('|')
    const target = (bar === -1 ? inner : inner.slice(0, bar)).trim()
    if (target === '') continue
    links.push({
      target,
      start,
      end: start + match[0].length,
      alias: bar === -1 ? null : inner.slice(bar + 1).trim(),
    })
  }
  return links
}

/** Splits `Folder/Name#Heading` into the note part and the heading part (block ids `^x` count as headings). */
export function splitTarget(target: string): { note: string; heading: string | null } {
  const hash = target.indexOf('#')
  if (hash === -1) return { note: target.trim(), heading: null }
  return { note: target.slice(0, hash).trim(), heading: target.slice(hash + 1) }
}

export function withoutMd(value: string): string {
  return value.replace(/\.md$/i, '')
}

export interface NoteIndex {
  has(path: string): boolean
  /** Lower-cased full path -> paths. */
  byLowerPath: Map<string, string[]>
  /** Lower-cased `name.md` and every `folder/name.md` suffix -> paths. */
  bySuffix: Map<string, string[]>
}

/** Appends in place: copying the bucket per note made common basenames quadratic. */
function pushTo(map: Map<string, string[]>, key: string, value: string): void {
  const bucket = map.get(key)
  if (bucket === undefined) map.set(key, [value])
  else bucket.push(value)
}

export function buildNoteIndex(paths: Iterable<string>): NoteIndex {
  const all = new Set<string>()
  const byLowerPath = new Map<string, string[]>()
  const bySuffix = new Map<string, string[]>()
  for (const notePath of paths) {
    all.add(notePath)
    const lower = notePath.toLowerCase()
    pushTo(byLowerPath, lower, notePath)
    const segments = lower.split('/')
    for (let index = 0; index < segments.length; index++) {
      const suffix = segments.slice(index).join('/')
      pushTo(bySuffix, suffix, notePath)
    }
  }
  return { has: (candidate) => all.has(candidate), byLowerPath, bySuffix }
}

/**
 * Resolves a link target against the vault's note paths: exact path (case-sensitive first, then not), then a
 * unique basename or path suffix, case-insensitive. Ambiguous or missing targets resolve to null.
 * `[[#Heading]]` links to the note it is in.
 */
export function resolveLink(target: string, fromPath: string, index: NoteIndex): string | null {
  const { note } = splitTarget(target)
  if (note === '') return index.has(fromPath) ? fromPath : null
  const cleaned = withoutMd(note.replace(/^\/+/, ''))
  if (cleaned === '' || cleaned.includes('\\')) return null
  const key = `${cleaned.toLowerCase()}.md`
  const exact = index.byLowerPath.get(key)
  if (exact !== undefined) {
    // Two paths can differ only by case; prefer the one written exactly.
    return exact.length === 1 ? exact[0]! : exact.includes(`${cleaned}.md`) ? `${cleaned}.md` : null
  }
  const suffix = index.bySuffix.get(key)
  return suffix !== undefined && suffix.length === 1 ? suffix[0]! : null
}

/** The link text to use for `to` after a move: a bare name when that stays unambiguous, else the full path. */
export function linkTextFor(to: string, after: NoteIndex): string {
  const full = withoutMd(to)
  const name = path.posix.basename(full)
  const clashes = after.bySuffix.get(`${name.toLowerCase()}.md`) ?? []
  return clashes.filter((candidate) => candidate !== to).length === 0 ? name : full
}

/**
 * Rewrites links in `text` that resolve to `from` so they point at `to`. `before` is the note index before the
 * move, `after` the one after. Headings and aliases are kept. Returns the new text and the count.
 */
export function rewriteLinks(
  text: string,
  notePath: string,
  from: string,
  to: string,
  before: NoteIndex,
  after: NoteIndex,
): { text: string; count: number } {
  let out = ''
  let cursor = 0
  let count = 0
  for (const link of parseWikilinks(text)) {
    if (resolveLink(link.target, notePath, before) !== from) continue
    const { note, heading } = splitTarget(link.target)
    if (note === '') continue // `[[#heading]]` inside the moved note stays
    const next = `${linkTextFor(to, after)}${heading === null ? '' : `#${heading}`}`
    const alias = link.alias === null ? '' : `|${link.alias}`
    out += `${text.slice(cursor, link.start)}[[${next}${alias}]]`
    cursor = link.end
    count++
  }
  return { text: out + text.slice(cursor), count }
}
