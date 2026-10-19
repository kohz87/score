import { AgentSummarySchema, type AgentSummary } from '@score/contract'
import { useMutation } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { apiFetch, apiUpload, type UploadProgress as Progress } from '../../data/api.ts'
import { UploadProgress } from '../../components/UploadProgress.tsx'
import { newId } from '../../data/ids.ts'
import { packProblems } from './pack-errors.ts'
import { PetPackGuide } from './PetPackGuide.tsx'

const ACCEPT = '.zip,.webp,.png,.gif,.json,application/zip,image/webp,image/png,image/gif'
const FILE_MAX_BYTES = 8 * 1024 * 1024
const PACK_MAX_BYTES = 64 * 1024 * 1024

type Added = { activities: string[]; ignored: string[] }

/** What a person is told before anything is sent, or null when the choice can go to the server. */
export function packChoiceProblem(files: readonly File[]): string | null {
  if (files.length === 0) return null
  const zips = files.filter((file) => /\.zip$/i.test(file.name))
  if (zips.length > 0 && files.length > 1)
    return 'Choose one .zip, or the activity files themselves, not both.'
  // 8 MB is the limit of one image; a zip is held to the pack's 64 MB as a whole.
  const big = files.find((file) => !/\.zip$/i.test(file.name) && file.size > FILE_MAX_BYTES)
  if (big) return `${big.name} is larger than 8 MB.`
  if (files.reduce((sum, file) => sum + file.size, 0) > PACK_MAX_BYTES)
    return 'The pack is larger than 64 MB.'
  return null
}

/** Upload, replace or remove the agent's pet pack (decisions 107–108), with the server's reasons and the files it ignored. */
export function PetPackSection({ agent }: { agent: AgentSummary }) {
  const input = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [problems, setProblems] = useState<string[]>([])
  const [added, setAdded] = useState<Added | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const pack = agent.style.pack
  const base = `agents/${encodeURIComponent(agent.id)}/pack`
  const upload = useMutation({
    mutationFn: async (chosen: File[]) => {
      const form = new FormData()
      for (const file of chosen) form.append('file', file, file.name)
      setProgress({ loaded: 0, total: chosen.reduce((sum, file) => sum + file.size, 0) })
      const body = (await apiUpload(base, form, setProgress, {
        'Idempotency-Key': newId(),
      })) as { agent?: unknown; ignored?: unknown }
      const summary = AgentSummarySchema.parse(body.agent)
      const ignored = Array.isArray(body.ignored)
        ? body.ignored.filter((name): name is string => typeof name === 'string').sort()
        : []
      return { summary, ignored }
    },
    onSettled: () => setProgress(null),
    onSuccess: ({ summary, ignored }) => {
      setFiles([])
      setProblems([])
      setAdded({ activities: summary.style.pack?.activities ?? [], ignored })
    },
    onError: (error) => {
      setAdded(null)
      setProblems(packProblems(error))
    },
  })
  const remove = useMutation({
    mutationFn: async () =>
      AgentSummarySchema.parse(
        await apiFetch(base, { method: 'DELETE', headers: { 'Idempotency-Key': newId() } }),
      ),
    onSuccess: () => {
      setProblems([])
      setAdded(null)
    },
    onError: (error) => setProblems(packProblems(error)),
  })
  const busy = upload.isPending || remove.isPending
  function choose(list: FileList | null) {
    upload.reset()
    setAdded(null)
    const chosen = list ? [...list] : []
    const problem = packChoiceProblem(chosen)
    setProblems(problem ? [problem] : [])
    setFiles(problem ? [] : chosen)
  }
  return (
    <section className="team-pack" aria-label="Pet pack">
      <h3>Pet pack</h3>
      <p className="team-muted">
        Give {agent.name} an animated avatar from a pet pack: a ZIP, or the activity files
        themselves. The mark stays as its badge and in lists.
      </p>
      {pack && (
        <p className="team-pack-current">
          <strong>{pack.name ?? 'Pet pack'}</strong> · {pack.activities.join(', ')}
          {pack.credits && <span className="team-muted"> · {pack.credits}</span>}
        </p>
      )}
      <input
        ref={input}
        className="team-pack-input"
        type="file"
        multiple
        accept={ACCEPT}
        aria-label="Pet pack files"
        tabIndex={-1}
        onChange={(event) => {
          choose(event.target.files)
          event.target.value = ''
        }}
      />
      {files.length > 0 && (
        <ul className="team-pack-files" aria-label="Chosen files">
          {files.map((file) => (
            <li key={file.name}>{file.name}</li>
          ))}
        </ul>
      )}
      {upload.isPending && progress && (
        <UploadProgress
          after="Checking the pack…"
          name={files.length === 1 ? files[0]!.name : `${files.length} files`}
          progress={progress}
        />
      )}
      <div className="team-style-actions">
        {files.length > 0 ? (
          <>
            <button
              type="button"
              className="team-primary"
              disabled={busy}
              onClick={() => upload.mutate(files)}
            >
              {upload.isPending ? 'Uploading…' : 'Use this pack'}
            </button>
            <button type="button" disabled={busy} onClick={() => setFiles([])}>
              Cancel pack
            </button>
          </>
        ) : (
          <button type="button" disabled={busy} onClick={() => input.current?.click()}>
            {pack ? 'Replace pet pack…' : 'Upload a pet pack…'}
          </button>
        )}
        {pack && files.length === 0 && (
          <button type="button" disabled={busy} onClick={() => remove.mutate()}>
            {remove.isPending ? 'Removing…' : 'Remove pack'}
          </button>
        )}
      </div>
      {problems.length > 0 && (
        <ul role="alert" className="team-pack-problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {added && (
        <div role="status" className="team-pack-added">
          <p>Pack added: {added.activities.join(', ')}.</p>
          {added.ignored.length > 0 && (
            <>
              <p>Left out (not an activity file or pet.json):</p>
              <ul>
                {added.ignored.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <PetPackGuide />
    </section>
  )
}
