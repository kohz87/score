import type { Message } from '@score/contract'
import { useState } from 'react'
import { FolderPicker } from './FolderPicker.tsx'
import { Modal } from './KnowledgeDialogs.tsx'
import { isSupportedName } from './knowledge-files.ts'
import { summaryText, useUploadFlow, type UploadItem } from './UploadFlow.tsx'
import './knowledge.css'

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

interface Candidate {
  key: string
  label: string
  supported: boolean
  build: () => Promise<UploadItem>
}

const stamp = (iso: string) => {
  const date = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`
}
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const safeName = (name: string) => name.replace(/[\u0000-\u001f\\/:*?"<>|]/g, '-').trim()

/** What a message offers to save: its attachments, and an agent's reply text as a note. */
export function saveCandidates(message: Message, authorName: string): Candidate[] {
  const candidates: Candidate[] = []
  for (const part of message.parts) {
    if (part.kind === 'document')
      candidates.push({
        key: `doc:${part.mediaId}`,
        label: part.name,
        supported: isSupportedName(part.name),
        build: async () => ({ name: part.name, mediaId: part.mediaId }),
      })
    else if (part.kind === 'image')
      candidates.push({
        key: `img:${part.mediaId}`,
        label: 'Image',
        supported: true,
        build: async () => {
          const response = await fetch(`/api/media/${encodeURIComponent(part.mediaId)}`, {
            credentials: 'same-origin',
          })
          if (!response.ok) throw new Error('Couldn’t load the image')
          const blob = await response.blob()
          const extension = IMAGE_EXTENSIONS[blob.type] ?? 'png'
          return { name: `image-${part.mediaId.slice(0, 8)}.${extension}`, blob }
        },
      })
  }
  const text = message.parts
    .flatMap((part) => (part.kind === 'text' ? [part.text] : []))
    .join('\n\n')
    .trim()
  if (message.author.kind !== 'you' && text !== '')
    candidates.push({
      key: 'reply',
      label: `This reply as a note`,
      supported: true,
      build: async () => {
        const title = `Reply from ${authorName} ${stamp(message.createdAt)}`
        const body = `# ${title}\n\n${text}\n\n---\nSaved from [chat](/chat/${encodeURIComponent(message.roomId)}#message-${encodeURIComponent(message.id)}).\n`
        return {
          name: `${safeName(title)}.md`,
          blob: new Blob([body], { type: 'text/markdown' }),
        }
      },
    })
  return candidates
}

/** "Save to Knowledge" for one chat message: pick the folder and what to keep. */
export function SaveToKnowledge({
  message,
  authorName,
  onClose,
}: {
  message: Message
  authorName: string
  onClose: () => void
}) {
  const candidates = saveCandidates(message, authorName)
  const [chosen, setChosen] = useState(
    () => new Set(candidates.filter((c) => c.supported).map((c) => c.key)),
  )
  const [folder, setFolder] = useState('inbox')
  const [result, setResult] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const flow = useUploadFlow()

  async function save() {
    setWorking(true)
    try {
      const items: UploadItem[] = []
      const problems: string[] = []
      for (const candidate of candidates)
        if (chosen.has(candidate.key))
          try {
            items.push(await candidate.build())
          } catch {
            problems.push(`${candidate.label}: couldn’t be read`)
          }
      const summary = await flow.start(items, folder.trim().replace(/\/+$/, ''))
      summary.problems.push(...problems)
      setResult(summaryText(summary) || 'Nothing was added.')
    } finally {
      setWorking(false)
    }
  }

  // A zip or name-clash question takes the screen; this dialog keeps its state and comes back after.
  if (flow.dialogs) return <>{flow.dialogs}</>
  return (
    <Modal title="Save to Knowledge" onClose={onClose}>
      {result !== null ? (
        <>
          <p role="status">{result}</p>
          <div className="kn-actions">
            <button type="button" className="kn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <fieldset className="kn-choice">
            <legend className="kn-sr">What to save</legend>
            {candidates.map((candidate) => (
              <label key={candidate.key} className="kn-radio">
                <input
                  type="checkbox"
                  checked={chosen.has(candidate.key)}
                  disabled={!candidate.supported}
                  onChange={(event) =>
                    setChosen((current) => {
                      const next = new Set(current)
                      if (event.target.checked) next.add(candidate.key)
                      else next.delete(candidate.key)
                      return next
                    })
                  }
                />
                {candidate.label}
                {!candidate.supported && (
                  <span className="kn-muted"> (this type can’t be saved)</span>
                )}
              </label>
            ))}
          </fieldset>
          <label>
            Folder
            <FolderPicker value={folder} onChange={setFolder} label="Folder in Knowledge" />
          </label>
          <div className="kn-actions">
            <button type="submit" className="kn-primary" disabled={chosen.size === 0 || working}>
              {working ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}
