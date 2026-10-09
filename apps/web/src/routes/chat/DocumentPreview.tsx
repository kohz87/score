import type { MessagePart } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef } from 'react'
import { Link, useInRouterContext } from 'react-router'
import { formatSize, previewKind, type PreviewKind } from './attachments.ts'
import { MAX_CSV_ROWS, parseCsv } from './csv.ts'
import { Markdown } from './Markdown.tsx'
import { workspaceFileLink } from './workspace-link.ts'

// Previews are text on the page, never a frame of the file: HTML is shown as source, Markdown goes through the chat
// renderer (no raw HTML), and PDFs open in the browser's own tab.
const MAX_PREVIEW_BYTES = 512 * 1024
const MAX_FETCH_BYTES = 2 * 1024 * 1024

export const mediaUrl = (mediaId: string, download?: string) =>
  `/api/media/${encodeURIComponent(mediaId)}${
    download === undefined ? '' : `?download=1&name=${encodeURIComponent(download)}`
  }`

/** A table of CSV text, at most 1000 rows; the first row is the header. */
export function CsvTable({ text }: { text: string }) {
  const { rows, truncated } = useMemo(() => parseCsv(text), [text])
  if (!rows.length) return <p className="chat-doc-note">This file is empty.</p>
  const [head, ...body] = rows
  return (
    <div className="chat-doc-table-wrap">
      <table className="chat-doc-table">
        <thead>
          <tr>
            {head!.map((cell, column) => (
              <th key={column} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, index) => (
            <tr key={index}>
              {row.map((cell, column) => (
                <td key={column}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <p className="chat-doc-note">
          Showing the first {MAX_CSV_ROWS} rows. Download the file for the rest.
        </p>
      )}
    </div>
  )
}

/** The text of a previewable file, rendered for its kind. */
export function TextPreview({ kind, text }: { kind: PreviewKind; text: string }) {
  const clipped = text.length > MAX_PREVIEW_BYTES
  const shown = clipped ? text.slice(0, MAX_PREVIEW_BYTES) : text
  let body
  if (kind === 'markdown')
    body = (
      <div className="chat-doc-markdown">
        <Markdown text={shown} />
      </div>
    )
  else if (kind === 'csv') body = <CsvTable text={shown} />
  else {
    let content = shown
    if (kind === 'json' && !clipped) {
      try {
        content = JSON.stringify(JSON.parse(shown), null, 2)
      } catch {
        // Shown as it is.
      }
    }
    body = (
      <pre className="chat-doc-text" tabIndex={0}>
        {content}
      </pre>
    )
  }
  return (
    <>
      {kind === 'html' && (
        <p className="chat-doc-note">HTML files are shown as source and never run.</p>
      )}
      {body}
      {clipped && <p className="chat-doc-note">Only the first 512 KB are shown.</p>}
    </>
  )
}

function useText(url: string, enabled: boolean) {
  return useQuery({
    queryKey: ['chat', 'document-text', url],
    enabled,
    retry: false,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const response = await fetch(url, { credentials: 'same-origin', signal })
      if (!response.ok) throw new Error('Could not load the file')
      return response.text()
    },
  })
}

function OpenInWorkspace({ agentId, path }: { agentId: string; path: string }) {
  const inRouter = useInRouterContext()
  const to = workspaceFileLink(agentId, path)
  return inRouter ? (
    <Link className="chat-doc-button" to={to}>
      Open in workspace
    </Link>
  ) : (
    <a className="chat-doc-button" href={to}>
      Open in workspace
    </a>
  )
}

type DocumentPart = Extract<MessagePart, { kind: 'document' }>

/** Preview of an attached document in a modal dialog (images and PDFs do not need one). */
export function DocumentDialog({ part, onClose }: { part: DocumentPart; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  const kind = previewKind(part.contentType)
  const url = mediaUrl(part.mediaId)
  const textual = kind !== 'office' && kind !== 'pdf' && kind !== 'image'
  const tooBig = part.size > MAX_FETCH_BYTES
  const text = useText(url, textual && !tooBig)
  const saved = part.saved?.[0]
  return (
    <dialog
      ref={dialog}
      className="chat-doc-dialog"
      aria-labelledby="chat-doc-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close()
      }}
    >
      <h2 id="chat-doc-title">{part.name}</h2>
      <p className="chat-doc-note">
        {part.contentType} · {formatSize(part.size)}
      </p>
      <div className="chat-doc-body">
        {kind === 'office' && (
          <p className="chat-doc-note">
            Score can’t show Word and Excel files. Download it, or open the copy the agent got.
          </p>
        )}
        {kind === 'pdf' && <p className="chat-doc-note">PDF files open in their own tab.</p>}
        {textual && tooBig && (
          <p className="chat-doc-note">This file is too large to preview. Download it instead.</p>
        )}
        {textual && !tooBig && text.isPending && <p role="status">Loading…</p>}
        {textual && text.isError && <p role="alert">Could not load this file.</p>}
        {textual && text.data !== undefined && <TextPreview kind={kind} text={text.data} />}
      </div>
      <div className="chat-doc-actions">
        {kind === 'pdf' && (
          <a className="chat-doc-button" href={url} target="_blank" rel="noreferrer">
            Open PDF
          </a>
        )}
        <a className="chat-doc-button" href={mediaUrl(part.mediaId, part.name)}>
          Download
        </a>
        {saved && <OpenInWorkspace agentId={saved.agentId} path={saved.path} />}
        <button
          type="button"
          className="chat-doc-button chat-doc-close"
          onClick={() => dialog.current?.close()}
        >
          Close
        </button>
      </div>
    </dialog>
  )
}
