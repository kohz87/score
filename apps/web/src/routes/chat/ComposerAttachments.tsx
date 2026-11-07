import type { Dispatch, SetStateAction } from 'react'
import { UploadProgress } from '../../components/UploadProgress.tsx'
import { ChipSaveOption } from '../knowledge/ChipSaveOption.tsx'
import { isSupportedName } from '../knowledge/knowledge-files.ts'
import { attachmentKey, attachmentName, isImage, type Attachment } from './attachments.ts'
import type { SendingFile } from './composer-types.ts'

/** Images, PDF, DOCX and text files can go to Knowledge; XLSX and anything else cannot. */
function canSaveToKnowledge(item: { name: string; contentType: string }): boolean {
  return item.contentType.startsWith('image/') || isSupportedName(item.name)
}

export function ComposerAttachments({
  attachments,
  uploading,
  sendingFiles,
  saveTo,
  setSaveTo,
  onRemove,
}: {
  attachments: Attachment[]
  uploading: number
  sendingFiles: SendingFile[]
  saveTo: Record<string, string>
  setSaveTo: Dispatch<SetStateAction<Record<string, string>>>
  onRemove: (item: Attachment) => void
}) {
  if (attachments.length === 0 && uploading === 0) return null
  return (
    <ul className="chat-attachments" aria-label="Attachments">
      {attachments.map((item) => (
        <li
          key={attachmentKey(item)}
          className={`chat-attachment${item.kind === 'upload' && canSaveToKnowledge(item) ? ' has-save' : ''}`}
        >
          {item.kind === 'upload' && isImage(item.contentType) ? (
            <img src={`/api/media/${encodeURIComponent(item.mediaId)}`} alt="" />
          ) : (
            <span className="chat-attachment-icon" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M4 1.8 H9.4 L12.6 5 V13.4 A0.8 0.8 0 0 1 11.8 14.2 H4 A0.8 0.8 0 0 1 3.2 13.4 V2.6 A0.8 0.8 0 0 1 4 1.8 Z M9.2 1.9 V5.2 H12.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          )}
          <span title={item.kind === 'workspace' ? `${item.agentId}: ${item.path}` : undefined}>
            {item.kind === 'workspace' ? item.path : attachmentName(item)}
          </span>
          {item.kind === 'upload' && canSaveToKnowledge(item) && (
            <ChipSaveOption
              name={item.name}
              folder={saveTo[item.mediaId] ?? null}
              onChange={(folder) =>
                setSaveTo((current) => {
                  const next = { ...current }
                  if (folder === null) delete next[item.mediaId]
                  else next[item.mediaId] = folder
                  return next
                })
              }
            />
          )}
          <button
            type="button"
            aria-label={`Remove ${attachmentName(item)}`}
            onClick={() => onRemove(item)}
          >
            ×
          </button>
        </li>
      ))}
      {sendingFiles.map((item) => (
        <li key={item.key} className="chat-attachment">
          <UploadProgress name={item.name} progress={item.progress} after="Checking…" compact />
        </li>
      ))}
    </ul>
  )
}
