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
const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/

/** Leading columns of a line (a tab counts to the next multiple of four). */
function indentOf(line: string): number {
  let columns = 0
  for (const char of line) {
    if (char === ' ') columns++
    else if (char === '\t') columns += 4 - (columns % 4)
    else break
  }
  return columns
}

/**
 * Block-level literals (CommonMark): fenced code (opened by 3+ backticks or tildes, indented up to 3 spaces; closed
 * by the same character, at least as long, nothing else on the line; an unclosed fence runs to the end) and indented
 * code (4+ columns after a blank line or at the start; it cannot interrupt a paragraph, and inside a list the
 * indentation continues the item instead).
 */
function blockCodeRanges(text: string): Range[] {
  const ranges: Range[] = []
  let offset = 0
  let fence: { char: string; length: number; start: number } | null = null
  let previousBlank = true
  let inList = false
  let indented: { start: number; end: number } | null = null
  const flushIndented = () => {
    if (indented) ranges.push([indented.start, indented.end])
    indented = null
  }
  for (const line of text.split('\n')) {
    const lineStart = offset
    const lineEnd = offset + line.length
    offset = lineEnd + 1
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.char}{${fence.length},}[ \\t]*\\r?$`).test(line)
      if (close) {
        ranges.push([fence.start, lineEnd])
        fence = null
        previousBlank = false
      }
      continue
    }
    const blank = line.trim() === ''
    if (blank) {
      previousBlank = true
      continue
    }
    const open = FENCE_OPEN.exec(line)
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
      flushIndented()
      fence = { char: open[1]![0]!, length: open[1]!.length, start: lineStart }
      previousBlank = false
      continue
    }
    if (indentOf(line) >= 4 && (previousBlank || indented) && !inList) {
      indented ??= { start: lineStart, end: lineEnd }
      indented.end = lineEnd
      previousBlank = false
      continue
    }
    flushIndented()
    if (LIST_MARKER.test(line)) inList = true
    else if (previousBlank && indentOf(line) === 0) inList = false
    previousBlank = false
  }
  if (fence) ranges.push([fence.start, text.length])
  flushIndented()
  return ranges
}

interface BacktickRun {
  start: number
  length: number
  /** An odd number of backslashes directly before it: its first backtick is literal outside code. */
  escaped: boolean
}

/** Ranges (sorted, disjoint) of fenced and indented code blocks and inline code spans, which never contain links. */
export function codeRanges(text: string): Array<[number, number]> {
  const blocks = blockCodeRanges(text)
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
  const byLength = new Map<number, number[]>()
  runs.forEach((run, position) => {
    byLength.set(run.length, [...(byLength.get(run.length) ?? []), position])
  })
  const breaks: number[] = []
  for (const match of text.matchAll(/\n[ \t]*\r?\n/g)) breaks.push(match.index)
  const paragraphOf = (position: number): number => {
    let low = 0
    let high = breaks.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (breaks[mid]! < position) low = mid + 1
      else high = mid
    }
    return low
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

export function buildNoteIndex(paths: Iterable<string>): NoteIndex {
  const all = new Set<string>()
  const byLowerPath = new Map<string, string[]>()
  const bySuffix = new Map<string, string[]>()
  for (const notePath of paths) {
    all.add(notePath)
    const lower = notePath.toLowerCase()
    byLowerPath.set(lower, [...(byLowerPath.get(lower) ?? []), notePath])
    const segments = lower.split('/')
    for (let index = 0; index < segments.length; index++) {
      const suffix = segments.slice(index).join('/')
      bySuffix.set(suffix, [...(bySuffix.get(suffix) ?? []), notePath])
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
