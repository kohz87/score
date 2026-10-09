import { redact } from '../redact.ts'
import { isTextType } from '../media/sniff.ts'
import { WorkspaceError } from '../workspace/policy.ts'

export const INLINE_FILE_BYTES = 64 * 1024
export const INLINE_MESSAGE_BYTES = 200 * 1024
const MAX_COPIES = 50

export interface AttachedDocument {
  mediaId: string
  name: string
  contentType: string
  size: number
  /** Reads the stored bytes; called once, when that file is handled, so ten big files are never in memory together. */
  load(): Buffer
}
export interface WorkspaceReference {
  agentId: string
  path: string
}
/** The part of an agent's workspace that saving needs (the Workspace class satisfies it). */
export interface AttachmentWorkspace {
  create(path: string, kind: 'dir'): Promise<void>
  upload(path: string, bytes: Buffer): Promise<unknown>
  read(path: string, options: { download: true }): Promise<{ kind: string; bytes?: Buffer }>
}

/** A file name that is safe as one path component: no directories, control characters or leading dots. */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{N}._ ()+-]/gu, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 100)
  return cleaned || 'file'
}

const FENCE_LANGUAGE: Record<string, string> = {
  'text/markdown': 'markdown',
  'text/csv': 'csv',
  'application/json': 'json',
  'text/html': 'html',
}

function fenced(text: string, language: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${text}\n${fence}`
}

const kb = (size: number) => (size < 1024 ? `${size} B` : `${Math.round(size / 1024)} KB`)

// Cuts on a character boundary: a partial UTF-8 sequence at the end becomes nothing, never a replacement character.
function textOf(bytes: Buffer, limit: number): { text: string; truncated: boolean } {
  const truncated = bytes.length > limit
  const text = bytes.subarray(0, limit).toString('utf8').replace(/�+$/, '')
  return { text, truncated }
}

/**
 * The run-input text for one addressed agent (PLAN 5.30): text files inline (fenced, redacted, bounded), binary
 * documents saved under `attachments/<day>/` in that agent's workspace, workspace references named by path.
 * `workspace` is only called when a document has to be saved; if it throws, only the file names are sent.
 */
export async function attachmentNote(input: {
  agentId: string
  documents: readonly AttachedDocument[]
  references: readonly WorkspaceReference[]
  day: string
  workspace: () => Promise<AttachmentWorkspace>
}): Promise<{ note: string; notices: string[]; saved: { mediaId: string; path: string }[] }> {
  const blocks: string[] = []
  const notices: string[] = []
  const saved: { mediaId: string; path: string }[] = []
  let budget = INLINE_MESSAGE_BYTES
  let workspace: AttachmentWorkspace | null | undefined
  let unavailable = ''
  const used = new Set<string>()
  for (const document of input.documents) {
    const file = { ...document, bytes: document.load() }
    if (isTextType(file.contentType)) {
      const head = `Attached file: ${file.name} (${file.contentType}, ${kb(file.size)})`
      if (budget <= 0) {
        blocks.push(
          `${head}\n(not included: the message already carries ${kb(INLINE_MESSAGE_BYTES)} of files)`,
        )
        continue
      }
      const limit = Math.min(INLINE_FILE_BYTES, budget)
      // Scrub before cutting, but only a window the size of the cut plus slack, not a 25 MB file.
      const window = textOf(file.bytes, limit + 4096)
      const shown = textOf(Buffer.from(redact(window.text)), limit)
      const text = shown.text
      const cut = window.truncated || shown.truncated
      budget -= Buffer.byteLength(text)
      blocks.push(
        `${head}\n${fenced(text, FENCE_LANGUAGE[file.contentType] ?? '')}${
          cut ? `\n(truncated: only the first ${kb(Buffer.byteLength(text))} are shown)` : ''
        }`,
      )
      continue
    }
    if (workspace === undefined) {
      try {
        workspace = await input.workspace()
      } catch (error) {
        workspace = null
        unavailable = error instanceof Error ? error.message : 'the workspace is unavailable'
      }
    }
    if (!workspace) {
      blocks.push(`Attached (could not be saved to your workspace): ${file.name}`)
      notices.push(`${file.name} was not saved for @${input.agentId}: ${unavailable}`)
      continue
    }
    try {
      const path = await saveDocument(workspace, input.day, file, used)
      saved.push({ mediaId: file.mediaId, path })
      blocks.push(`Attached: ${path}`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'it could not be written'
      blocks.push(`Attached (could not be saved to your workspace): ${file.name}`)
      notices.push(`${file.name} was not saved for @${input.agentId}: ${reason}`)
    }
  }
  for (const ref of input.references)
    blocks.push(
      ref.agentId === input.agentId
        ? `Workspace file: ${ref.path}`
        : `Workspace file in @${ref.agentId}'s workspace: ${ref.path}`,
    )
  return { note: blocks.length ? `\n\n${blocks.join('\n\n')}` : '', notices, saved }
}

async function saveDocument(
  workspace: AttachmentWorkspace,
  day: string,
  file: AttachedDocument & { bytes: Buffer },
  used: Set<string>,
): Promise<string> {
  for (const dir of ['attachments', `attachments/${day}`])
    await workspace.create(dir, 'dir').catch((error: unknown) => {
      if (!(error instanceof WorkspaceError && error.code === 'exists')) throw error
    })
  const name = safeFileName(file.name)
  const dot = name.lastIndexOf('.')
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let copy = 1; copy <= MAX_COPIES; copy += 1) {
    const path = `attachments/${day}/${copy === 1 ? name : `${stem}-${copy}${extension}`}`
    if (used.has(path)) continue
    try {
      await workspace.upload(path, file.bytes)
      used.add(path)
      return path
    } catch (error) {
      if (!(error instanceof WorkspaceError && error.code === 'exists')) throw error
      // The same bytes already sit there (an edited message sent again): point at that file instead of copying.
      const existing = await workspace.read(path, { download: true }).catch(() => null)
      if (existing?.kind === 'download' && existing.bytes?.equals(file.bytes)) {
        used.add(path)
        return path
      }
    }
  }
  throw new Error('too many files with that name already exist')
}
