import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { apiUpload, ApiError, type UploadProgress as Progress } from '../../data/api.ts'
import { summaryText, useUploadFlow } from '../knowledge/UploadFlow.tsx'
import {
  attachmentKey,
  MAX_ATTACHMENTS,
  parseUpload,
  uploadProblem,
  type Attachment,
} from './attachments.ts'
import type { LiveDraft, Notice, SendingFile } from './composer-types.ts'

export function useComposerUploads({
  draftText,
  setNotice,
}: {
  draftText: string
  setNotice: Dispatch<SetStateAction<Notice | null>>
}) {
  // "Also save to Knowledge" (PLAN 6.6): mediaId -> folder for attachments the person chose to keep.
  const [saveTo, setSaveTo] = useState<Record<string, string>>({})
  const knowledgeFlow = useUploadFlow((summary) => {
    const text = summaryText(summary)
    if (text) setNotice({ kind: 'info', text })
  })
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(0)
  // Each file being sent has its own chip in the tray, keyed by a counter so two files of one name stay apart.
  const [sendingFiles, setSendingFiles] = useState<SendingFile[]>([])
  const sendingKey = useRef(0)
  const uploadsInFlight = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  // Latest values for the send callback, which resolves long after the closure was created.
  const live = useRef<LiveDraft>({ text: draftText, attachments })
  useEffect(() => {
    live.current = { text: draftText, attachments }
  })

  // Buttons, drag and drop and paste all end here. Every file is checked by the server from its bytes.
  async function upload(picked: File[]) {
    if (fileInput.current) fileInput.current.value = ''
    for (const file of picked) {
      const problem = uploadProblem(file)
      if (problem) {
        setNotice({ kind: 'error', text: problem })
        continue
      }
      if (live.current.attachments.length + uploadsInFlight.current >= MAX_ATTACHMENTS) {
        setNotice({
          kind: 'error',
          text: `A message can carry up to ${MAX_ATTACHMENTS} attachments.`,
        })
        break
      }
      uploadsInFlight.current += 1
      setUploading((count) => count + 1)
      const key = (sendingKey.current += 1)
      const name = file.name || 'pasted-file'
      const track = (progress: Progress) =>
        setSendingFiles((current) =>
          current.some((item) => item.key === key)
            ? current.map((item) => (item.key === key ? { ...item, progress } : item))
            : [...current, { key, name, progress }],
        )
      track({ loaded: 0, total: file.size })
      try {
        const form = new FormData()
        form.append('file', file, name)
        const stored = parseUpload(await apiUpload('media', form, track, {}, 'POST'))
        changeAttachments((current) =>
          current.length >= MAX_ATTACHMENTS ||
          current.some((item) => attachmentKey(item) === stored.mediaId)
            ? current
            : [...current, stored],
        )
      } catch (error) {
        const reason =
          error instanceof ApiError && error.status === 413
            ? 'is too large (images up to 8 MB, other files up to 25 MB)'
            : error instanceof ApiError && error.status === 415
              ? 'isn’t a type that can be attached (images, PDF, DOCX, XLSX, TXT, Markdown, CSV, JSON, HTML)'
              : 'couldn’t be uploaded'
        setNotice({ kind: 'error', text: `${file.name} ${reason}.` })
      } finally {
        setSendingFiles((current) => current.filter((item) => item.key !== key))
        uploadsInFlight.current -= 1
        setUploading((count) => count - 1)
      }
    }
  }
  // The ref moves first, so a loop of uploads counts what the previous one added before React re-renders.
  function changeAttachments(change: (current: Attachment[]) => Attachment[]) {
    const next = change(live.current.attachments)
    live.current = { ...live.current, attachments: next }
    setAttachments(next)
  }
  function addWorkspaceFile(agentId: string, path: string, root?: string) {
    changeAttachments((current) => {
      const item: Attachment = {
        kind: 'workspace',
        agentId,
        path,
        ...(root === undefined ? {} : { root }),
      }
      return current.length >= MAX_ATTACHMENTS ||
        current.some((existing) => attachmentKey(existing) === attachmentKey(item))
        ? current
        : [...current, item]
    })
  }

  // After the message is sent: the files marked "Also save to Knowledge" go there too, one folder at a time.
  async function saveSentToKnowledge(sent: Attachment[]) {
    const wanted = sent.flatMap((item) =>
      item.kind === 'upload' && saveTo[item.mediaId] !== undefined
        ? [
            {
              name: item.name,
              mediaId: item.mediaId,
              folder: saveTo[item.mediaId]!.trim().replace(/\/+$/, ''),
            },
          ]
        : [],
    )
    if (wanted.length === 0) return
    setSaveTo((current) => {
      const next = { ...current }
      for (const item of wanted) delete next[item.mediaId]
      return next
    })
    for (const folder of new Set(wanted.map((item) => item.folder)))
      await knowledgeFlow.start(
        wanted
          .filter((item) => item.folder === folder)
          .map((item) => ({ name: item.name, mediaId: item.mediaId })),
        folder,
      )
  }

  return {
    attachments,
    setAttachments,
    uploading,
    sendingFiles,
    saveTo,
    setSaveTo,
    knowledgeFlow,
    fileInput,
    live,
    upload,
    addWorkspaceFile,
    saveSentToKnowledge,
  }
}
