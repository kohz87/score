import type { MessagePart } from '@score/contract'
import { useState } from 'react'
import { Link, useInRouterContext } from 'react-router'
import { formatSize } from './attachments.ts'
import { DocumentDialog, mediaUrl } from './DocumentPreview.tsx'
import { workspaceFileLink } from './workspace-link.ts'

function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 1.8 H9.4 L12.6 5 V13.4 A0.8 0.8 0 0 1 11.8 14.2 H4 A0.8 0.8 0 0 1 3.2 13.4 V2.6 A0.8 0.8 0 0 1 4 1.8 Z M9.2 1.9 V5.2 H12.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** An attached document in a message: a PDF opens in its own tab, anything else in a preview dialog. */
export function DocumentChip({ part }: { part: Extract<MessagePart, { kind: 'document' }> }) {
  const [open, setOpen] = useState(false)
  const label = (
    <>
      <FileIcon />
      <span className="chat-file-chip-name">{part.name}</span>
      <span className="chat-file-chip-size">{formatSize(part.size)}</span>
    </>
  )
  if (part.contentType === 'application/pdf')
    return (
      <a
        className="chat-file-chip"
        href={mediaUrl(part.mediaId)}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${part.name} in a new tab`}
      >
        {label}
      </a>
    )
  return (
    <>
      <button
        type="button"
        className="chat-file-chip"
        aria-label={`Preview ${part.name}`}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {open && <DocumentDialog part={part} onClose={() => setOpen(false)} />}
    </>
  )
}

/** A reference to a workspace file (no copy was made): opens it in the agent's Workspace tab. */
export function WorkspaceChip({ part }: { part: Extract<MessagePart, { kind: 'workspace' }> }) {
  const inRouter = useInRouterContext()
  const to = workspaceFileLink(part.agentId, part.path)
  const body = (
    <>
      <FileIcon />
      <span className="chat-file-chip-name">{part.path}</span>
      <span className="chat-file-chip-size">workspace</span>
    </>
  )
  return inRouter ? (
    <Link className="chat-file-chip" to={to} aria-label={`Open ${part.path} in the workspace`}>
      {body}
    </Link>
  ) : (
    <a className="chat-file-chip" href={to} aria-label={`Open ${part.path} in the workspace`}>
      {body}
    </a>
  )
}
