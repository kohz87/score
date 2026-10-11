import path from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'

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

const LINE_PREFIX = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)[ \t>]*)*/
const MARKER_ONLY = /^[*_\-=\s]*$/
const DEFINITION = /^\[[^\]]*\]:/

/**
 * The parser's emphasis and link resolution is super-linear on long runs of `*`, `_`, `!`, brackets, `&` and `<`, and neither
 * changes where code is (code spans bind tighter, and block structure comes first). So those characters are
 * (and `&`, `<` inside a line) swapped for a same-length letter in line content, keeping offsets, container prefixes (list markers, `>`),
 * marker-only lines (thematic breaks, setext underlines) and link reference definitions as they are.
 */
function neutraliseInline(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const prefix = LINE_PREFIX.exec(line)![0]
      const rest = line.slice(prefix.length)
      if (MARKER_ONLY.test(rest) || (rest.length < 1000 && DEFINITION.test(rest))) return line
      // A `<` opening the line may start an HTML block, which does change what is code.
      const head = rest.startsWith('<') ? '<' : ''
      return prefix + head + rest.slice(head.length).replace(/[*_!&<[\]]/g, 'x')
    })
    .join('\n')
}

/**
 * Ranges (sorted, disjoint) of fenced and indented code blocks and inline code spans, which never contain links.
 * They come from the CommonMark parse tree (containers such as lists and blockquotes included), so indexing,
 * headings, images and rewrites all share one reading of where code is.
 */
export function codeRanges(text: string): Array<[number, number]> {
  // No backtick, tilde, tab or four spaces: nothing can be code, so skip the parser (most notes).
  if (!/[`~\t]| {4}/.test(text)) return []
  const found: Range[] = []
  // Iterative walk: a deeply nested document must not overflow the call stack.
  const stack: Array<
    ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>['children'][number]
  > = [fromMarkdown(neutraliseInline(text))]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.type === 'code' || node.type === 'inlineCode') {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start !== undefined && end !== undefined) found.push([start, end])
      continue
    }
    if ('children' in node) for (const child of node.children) stack.push(child)
  }
  found.sort((a, b) => a[0] - b[0])
  const merged: Range[] = []
  for (const range of found) {
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
