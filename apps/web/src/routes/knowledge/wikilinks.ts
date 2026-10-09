import type { KnowledgeLink, KnowledgeNoteSummary } from '@score/contract'

const WIKILINK = /\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g

/** The `href` prefix the preview uses for wikilinks; the link component turns it into a router link or a "missing" chip. */
export const WIKI_HREF = '#wiki:'

/** Obsidian-style resolution for the preview: exact path, then a unique basename, case-insensitive. The server resolves
 *  the note's own links (`links`); this covers links typed since the last save. */
export function resolveTarget(
  target: string,
  links: KnowledgeLink[],
  notes: KnowledgeNoteSummary[],
): string | null {
  // The server's answer wins when it has one; a null (unresolved when last read) falls through to the live note list,
  // so a note created since is found. Removals arrive with the refetched links.
  const known = links.find((link) => link.target === target)
  if (known?.path) return known.path
  const name = target.split('#')[0]!.trim().replace(/\.md$/i, '').toLowerCase()
  if (!name) return null
  const exact = notes.find((note) => note.path.replace(/\.md$/i, '').toLowerCase() === name)
  if (exact) return exact.path
  const byName = notes.filter(
    (note) => (note.path.split('/').pop() ?? '').replace(/\.md$/i, '').toLowerCase() === name,
  )
  return byName.length === 1 ? byName[0]!.path : null
}

/** Rewrites `[[Target|alias]]` into Markdown links the preview renders itself. Skips fenced code blocks. */
export function wikilinksToMarkdown(body: string): string {
  let fenced = false
  return body
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
      if (fenced) return line
      return line.replace(WIKILINK, (_all, target: string, alias?: string) => {
        const label = (alias ?? target).replace(/[[\]]/g, '')
        return `[${label}](${WIKI_HREF}${encodeURIComponent(target.trim())})`
      })
    })
    .join('\n')
}

/** Snippets from search mark matches with `[[ ]]`. */
export function splitSnippet(snippet: string): { text: string; match: boolean }[] {
  const parts: { text: string; match: boolean }[] = []
  const pattern = /\[\[(.*?)\]\]/g
  let last = 0
  for (const found of snippet.matchAll(pattern)) {
    if (found.index > last) parts.push({ text: snippet.slice(last, found.index), match: false })
    parts.push({ text: found[1]!, match: true })
    last = found.index + found[0].length
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), match: false })
  return parts
}
