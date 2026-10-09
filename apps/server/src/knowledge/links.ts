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

/** Ranges of fenced code blocks and inline code, which never contain links. */
export function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const fence = /^(```|~~~)[^\n]*\n[\s\S]*?(?:\n\1[^\n]*(?=\n|$)|$)/gm
  for (const match of text.matchAll(fence))
    ranges.push([match.index, match.index + match[0].length])
  const inline = /(`+)(?!`)[^\n]*?[^`]\1(?!`)/g
  for (const match of text.matchAll(inline)) {
    const start = match.index
    if (!ranges.some(([from, to]) => start >= from && start < to))
      ranges.push([start, start + match[0].length])
  }
  return ranges
}

export function parseWikilinks(text: string): ParsedLink[] {
  const code = codeRanges(text)
  const links: ParsedLink[] = []
  for (const match of text.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
    const start = match.index
    if (code.some(([from, to]) => start >= from && start < to)) continue
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
