import type { MessageAttachment, MessagePart } from '@score/contract'
import {
  safeFileName,
  type AttachedDocument,
  type WorkspaceReference,
} from '../domain/attachment-input.ts'
import { HttpError } from '../errors.ts'
import { isImageType } from '../media/sniff.ts'
import type { MediaStore } from '../media/store.ts'
import type { AgentWorkspaces } from '../workspace/agent-workspace.ts'
import { assertAllowedSegments, parseRelativePath, WorkspaceError } from '../workspace/policy.ts'

export interface ResolvedAttachments {
  /** Every upload the message holds (retained in the message's transaction). */
  mediaIds: string[]
  /** The message parts, in the order the person attached them. */
  parts: MessagePart[]
  /** Uploads that are not images: handed to each addressed agent as text or as a saved file. */
  documents: AttachedDocument[]
  references: WorkspaceReference[]
}

/**
 * Checks a message's attachments before anything is stored: uploads must exist, workspace files must be real
 * files inside the named agent's workspace (same path rules as the Workspace routes, so a blocked or outside path
 * is refused here too).
 */
export async function resolveAttachments(
  attachments: readonly MessageAttachment[],
  media: MediaStore | undefined,
  workspaces: AgentWorkspaces | undefined,
  knownAgents: readonly string[],
): Promise<ResolvedAttachments> {
  const result: ResolvedAttachments = { mediaIds: [], parts: [], documents: [], references: [] }
  const seenReferences = new Set<string>()
  for (const item of attachments) {
    if ('mediaId' in item) {
      if (result.mediaIds.includes(item.mediaId)) continue
      const stored = media?.info(item.mediaId)
      if (!media || !stored) throw new HttpError(400, 'bad_request', 'Unknown attachment')
      result.mediaIds.push(item.mediaId)
      if (isImageType(stored.contentType)) {
        result.parts.push({ kind: 'image', mediaId: item.mediaId })
        continue
      }
      const name = safeFileName(item.name ?? 'file')
      result.parts.push({
        kind: 'document',
        mediaId: item.mediaId,
        name,
        contentType: stored.contentType,
        size: stored.size,
      })
      result.documents.push({
        mediaId: item.mediaId,
        name,
        contentType: stored.contentType,
        size: stored.size,
        load() {
          const bytes = media.read(item.mediaId)?.bytes
          if (!bytes) throw new Error('the attachment is no longer stored')
          return bytes
        },
      })
      continue
    }
    const { agentId } = item.workspace
    if (!knownAgents.includes(agentId)) throw new HttpError(400, 'bad_request', 'Unknown agent')
    if (!workspaces)
      throw new HttpError(409, 'workspace_unavailable', 'Workspaces are not available')
    let segments: string[]
    try {
      segments = parseRelativePath(item.workspace.path)
      if (segments.length === 0) throw new WorkspaceError(400, 'bad_path', 'That path is a folder')
      assertAllowedSegments(segments, 'read')
      const workspace = await workspaces.open(agentId)
      const entry = (await workspace.list(segments.slice(0, -1).join('/'))).find(
        (candidate) => candidate.name === segments[segments.length - 1],
      )
      if (entry?.kind !== 'file')
        throw new WorkspaceError(404, 'not_found', 'That workspace file does not exist')
    } catch (error) {
      if (error instanceof WorkspaceError)
        throw new HttpError(error.status, error.code, error.message, error.details)
      throw error
    }
    const path = segments.join('/')
    if (seenReferences.has(`${agentId}\0${path}`)) continue
    seenReferences.add(`${agentId}\0${path}`)
    result.parts.push({ kind: 'workspace', agentId, path })
    result.references.push({ agentId, path })
  }
  return result
}
