import { createHash } from 'node:crypto'
import path from 'node:path'
import matter from 'gray-matter'
import { KNOWLEDGE_NOTE_MAX_BYTES, type KnowledgeAuthor } from '@score/contract'
import { HttpError } from '../errors.ts'
import { parseRelativePath } from '../workspace/policy.ts'
import { codeRanges } from './links.ts'

export const MAX_NOTE_BYTES = KNOWLEDGE_NOTE_MAX_BYTES

// Path rules (contract §12, design 6.0 review item 1): POSIX, relative to the vault, no `..`, NUL or absolute
// paths, nothing under `.git`; notes end in `.md`; attachments live under `attachments/`.
export function parseVaultPath(input: string): string[] {
  let segments: string[]
  try {
    segments = parseRelativePath(input)
  } catch (error) {
    throw new HttpError(
      400,
      'bad_path',
      error instanceof Error ? error.message : 'The path is invalid.',
    )
  }
  if (segments.length === 0) throw new HttpError(400, 'bad_path', 'The path is empty.')
  if (segments.some((segment) => segment.toLowerCase() === '.git'))
    throw new HttpError(400, 'bad_path', 'That path isn’t available.')
  return segments
}

/** A note path, normalised (`a//b/./c.md` -> `a/b/c.md`). */
export function parseNotePath(input: string): string {
  const segments = parseVaultPath(input)
  if (!/\.md$/i.test(segments.at(-1)!) || segments.at(-1)!.toLowerCase() === '.md')
    throw new HttpError(400, 'not_a_note', 'Only Markdown notes (.md) can be used here.')
  if (segments.some((segment) => segment.startsWith('.')))
    throw new HttpError(400, 'bad_path', 'Hidden files and folders are not part of Knowledge.')
  return segments.join('/')
}

/** What may be written: notes and anything under `attachments/` (attachments have no route yet). */
export function isWritablePath(vaultPath: string): boolean {
  const segments = parseVaultPath(vaultPath)
  return /\.md$/i.test(segments.at(-1)!) || segments[0] === 'attachments'
}

export function hashContent(raw: Buffer | string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** The etag is the content hash, so an outside edit changes it too. */
export function etagOf(hash: string): string {
  return hash.slice(0, 32)
}

const noScripts = () => {
  throw new Error('Executable frontmatter is not supported')
}

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/

export interface ParsedNote {
  frontmatter: Record<string, unknown>
  body: string
  /** The raw frontmatter block including its fences and trailing newline, or ''. */
  prefix: string
}

/** Splits a note into frontmatter and body. Unparseable or script frontmatter counts as plain text. */
export function parseNote(raw: string): ParsedNote {
  const block = FRONTMATTER.exec(raw)
  if (!block) return { frontmatter: {}, body: raw, prefix: '' }
  try {
    // Passing options skips gray-matter's global cache; the js/coffee engines would eval, so they throw.
    const parsed = matter(block[0], {
      engines: { js: noScripts, javascript: noScripts, coffee: noScripts, json: JSON.parse },
    })
    const data: unknown = JSON.parse(JSON.stringify(parsed.data))
    const frontmatter =
      typeof data === 'object' && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {}
    return { frontmatter, body: raw.slice(block[0].length), prefix: block[0] }
  } catch {
    return { frontmatter: {}, body: raw, prefix: '' }
  }
}

export function serialiseNote(body: string, frontmatter: Record<string, unknown>): string {
  if (Object.keys(frontmatter).length === 0) return body
  // gray-matter appends a newline to the body; the block alone ends with one, so use it as the prefix.
  return matter.stringify('', frontmatter).replace(/\n\n$/, '\n') + body
}

/** Frontmatter `title`, else the first `# H1` outside code, else the file name. */
export function noteTitle(
  notePath: string,
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const fromFrontmatter = frontmatter.title
  if (typeof fromFrontmatter === 'string' && fromFrontmatter.trim() !== '')
    return fromFrontmatter.trim()
  const code = codeRanges(body)
  for (const match of body.matchAll(/^# +(.+?)\s*#*\s*$/gm)) {
    if (!code.some(([from, to]) => match.index >= from && match.index < to)) return match[1]!.trim()
  }
  return path.posix.basename(notePath).replace(/\.md$/i, '')
}

// ---- git author encoding ---------------------------------------------------------------------------------------

const safeId = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64) || 'agent'

export function gitIdentity(author: KnowledgeAuthor): { name: string; email: string } {
  if (author === 'you') return { name: 'You', email: 'you@score.local' }
  if (author === 'outside') return { name: 'Outside changes', email: 'outside@score.local' }
  const id = safeId(author.agentId)
  return { name: `${id} (agent)`, email: `${id}@score.local` }
}

export function authorFromGit(name: string, email: string): KnowledgeAuthor {
  if (email === 'you@score.local') return 'you'
  const agent = /^(.+) \(agent\)$/.exec(name)
  if (agent && email === `${agent[1]}@score.local`) return { agentId: agent[1]! }
  return 'outside'
}

export function authorToColumn(author: KnowledgeAuthor): string {
  return typeof author === 'string' ? author : `agent:${author.agentId}`
}

export function authorFromColumn(value: string | null): KnowledgeAuthor | null {
  if (value === 'you' || value === 'outside') return value
  if (value?.startsWith('agent:')) return { agentId: value.slice(6) }
  return null
}

export function sameAuthor(left: KnowledgeAuthor, right: KnowledgeAuthor): boolean {
  return authorToColumn(left) === authorToColumn(right)
}
