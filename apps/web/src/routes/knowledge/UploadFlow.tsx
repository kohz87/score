import type { KnowledgeZipPreview } from '@score/contract'
import { useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState, type ReactNode } from 'react'
import { ApiError, type UploadProgress } from '../../data/api.ts'
import { Modal } from './KnowledgeDialogs.tsx'
import {
  existingOf,
  formatBytes,
  isZipName,
  joinPath,
  previewZip,
  saveMedia,
  unzipBlob,
  uploadBlob,
  uploadProblem,
  type OnConflict,
} from './knowledge-files.ts'
import { knowledgeKey } from './knowledge-queries.ts'
import './knowledge.css'

/** One file to put into Knowledge: bytes in the browser, or a chat upload the server already holds. */
export type UploadItem = { name: string; blob: Blob } | { name: string; mediaId: string }

export interface UploadSummary {
  saved: string[]
  unzipped: Array<{ folder: string; count: number; skipped: number }>
  problems: string[]
}

type ZipChoice = { mode: 'unzip'; folder: string } | { mode: 'keep' } | { mode: 'skip' }
type ClashChoice = { choice: 'keep' | 'replace' | 'skip'; all: boolean }
type Decision =
  | {
      kind: 'zip'
      name: string
      preview: KnowledgeZipPreview
      folder: string
      resolve: (choice: ZipChoice) => void
    }
  | {
      kind: 'clash'
      name: string
      existing: Array<{ path: string; mtime: string; size: number }>
      remaining: number
      resolve: (choice: ClashChoice) => void
    }

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })

function problemText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'not_paired') return 'pair this browser to upload'
    return error.message
  }
  return 'the upload failed'
}

/**
 * Uploads files into a Knowledge folder one at a time (PLAN 6.6): a zip asks "unzip or keep", a name that exists
 * asks "keep both or replace" (once for a whole batch if the person ticks the box). Render `dialogs` somewhere.
 */
export function useUploadFlow(onFinished?: (summary: UploadSummary) => void) {
  const queryClient = useQueryClient()
  const [decision, setDecision] = useState<Decision | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const running = useRef(false)

  const ask = <T,>(make: (resolve: (value: T) => void) => Decision): Promise<T> =>
    new Promise<T>((resolve) =>
      setDecision(
        make((value) => {
          setDecision(null)
          resolve(value)
        }),
      ),
    )

  async function start(items: UploadItem[], folder: string): Promise<UploadSummary> {
    const summary: UploadSummary = { saved: [], unzipped: [], problems: [] }
    if (running.current) {
      summary.problems.push('Another upload is still running')
      return summary
    }
    running.current = true
    setBusy(true)
    const track =
      (name: string, index: number, count: number, step: Progress['step']) =>
      ({ loaded, total }: UploadProgress) =>
        setProgress({ name, index, count, step, loaded, total })
    let batchChoice: 'keep' | 'replace' | null = null
    const withConflict = async <T,>(
      name: string,
      remaining: number,
      run: (onConflict: OnConflict) => Promise<T>,
    ): Promise<T | null> => {
      let onConflict: OnConflict = batchChoice ?? 'ask'
      for (;;) {
        try {
          return await run(onConflict)
        } catch (error) {
          if (!(error instanceof ApiError && error.code === 'exists' && onConflict === 'ask'))
            throw error
          const answer = await ask<ClashChoice>((resolve) => ({
            kind: 'clash',
            name,
            existing: existingOf(error.details),
            remaining,
            resolve,
          }))
          if (answer.choice === 'skip') return null
          if (answer.all) batchChoice = answer.choice
          onConflict = answer.choice
        }
      }
    }
    try {
      for (const [index, item] of items.entries()) {
        const remaining = items.length - index - 1
        const target = joinPath(folder, item.name)
        const problem = uploadProblem({
          name: item.name,
          size: 'blob' in item ? item.blob.size : 1,
        })
        if (problem) {
          summary.problems.push(problem)
          continue
        }
        try {
          if ('blob' in item && isZipName(item.name)) {
            const preview = await previewZip(
              target,
              item.blob,
              track(item.name, index, items.length, 'check'),
            )
            const choice = await ask<ZipChoice>((resolve) => ({
              kind: 'zip',
              name: item.name,
              preview,
              folder: joinPath(folder, item.name.replace(/\.zip$/i, '')),
              resolve,
            }))
            if (choice.mode === 'skip') continue
            if (choice.mode === 'unzip') {
              const result = await withConflict(item.name, remaining, (onConflict) =>
                unzipBlob(
                  target,
                  item.blob,
                  choice.folder,
                  onConflict,
                  track(item.name, index, items.length, 'unzip'),
                ),
              )
              if (result)
                summary.unzipped.push({
                  folder: result.folder,
                  count: result.written.length,
                  skipped: result.skipped.length,
                })
              continue
            }
          }
          const result = await withConflict(item.name, remaining, (onConflict) =>
            'blob' in item
              ? uploadBlob(
                  target,
                  item.blob,
                  onConflict,
                  {},
                  track(item.name, index, items.length, 'upload'),
                )
              : saveMedia(item.mediaId, target, onConflict),
          )
          if (result) summary.saved.push(result.path)
        } catch (error) {
          summary.problems.push(`${item.name}: ${problemText(error)}`)
        }
      }
    } finally {
      running.current = false
      setBusy(false)
      setProgress(null)
      void queryClient.invalidateQueries({ queryKey: knowledgeKey })
    }
    onFinished?.(summary)
    return summary
  }

  const dialogs: ReactNode =
    decision?.kind === 'zip' ? (
      <ZipDialog decision={decision} />
    ) : decision?.kind === 'clash' ? (
      <ClashDialog decision={decision} />
    ) : progress ? (
      <UploadProgressPanel progress={progress} />
    ) : null
  return { start, busy, dialogs }
}

type Progress = {
  name: string
  index: number
  count: number
  step: 'check' | 'upload' | 'unzip'
  loaded: number
  total: number
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** How far an upload has got: the file, its step, and bytes sent; once everything is sent, what the server is doing. */
export function UploadProgressPanel({ progress }: { progress: Progress }) {
  const { name, index, count, step, loaded, total } = progress
  const sent = total > 0 && loaded >= total
  const doing = sent
    ? { check: 'Checking the zip…', upload: 'Saving…', unzip: 'Unzipping…' }[step]
    : {
        check: 'Sending the zip to check it',
        upload: 'Uploading',
        unzip: 'Sending the zip to unzip it',
      }[step]
  const percent = total > 0 ? Math.round((loaded / total) * 100) : 0
  return (
    <div className="kn-upload-progress" role="status" aria-live="polite">
      <p>
        <strong>{name}</strong>
        {count > 1 ? <span>{` · file ${index + 1} of ${count}`}</span> : null}
      </p>
      <p>
        {doing}
        {sent ? null : ` · ${percent}% · ${megabytes(loaded)} of ${megabytes(total)}`}
      </p>
      {sent ? (
        <progress aria-label={`${name}: ${doing}`} />
      ) : (
        <progress aria-label={`${name}: ${doing}`} max={total} value={loaded} />
      )}
    </div>
  )
}

function ZipDialog({ decision }: { decision: Extract<Decision, { kind: 'zip' }> }) {
  const [mode, setMode] = useState<'unzip' | 'keep'>('unzip')
  const [folder, setFolder] = useState(decision.folder)
  const group = useId()
  const { entries, extractCount, more } = decision.preview
  const skipped = entries.filter((entry) => entry.action === 'skip')
  const valid = folder.trim() !== '' && !/(^|\/)\.\.?(\/|$)/.test(folder)
  return (
    <Modal title={`Zip file: ${decision.name}`} onClose={() => decision.resolve({ mode: 'skip' })}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (mode === 'keep') decision.resolve({ mode: 'keep' })
          else if (valid)
            decision.resolve({ mode: 'unzip', folder: folder.trim().replace(/^\/+|\/+$/g, '') })
        }}
      >
        <fieldset className="kn-choice">
          <legend className="kn-sr">What to do with the zip</legend>
          <label className="kn-radio">
            <input
              type="radio"
              name={group}
              checked={mode === 'unzip'}
              onChange={() => setMode('unzip')}
            />
            Unzip into a folder
          </label>
          <label className="kn-radio">
            <input
              type="radio"
              name={group}
              checked={mode === 'keep'}
              onChange={() => setMode('keep')}
            />
            Keep as a zip (stored and downloadable, not searched)
          </label>
        </fieldset>
        {mode === 'unzip' && (
          <>
            <label>
              Folder
              <input
                value={folder}
                maxLength={500}
                onChange={(event) => setFolder(event.target.value)}
              />
            </label>
            <p className="kn-muted">
              {extractCount} {extractCount === 1 ? 'file' : 'files'} will be added
              {skipped.length > 0 ? `; ${skipped.length} will be skipped` : ''}.
            </p>
          </>
        )}
        <ul className="kn-zip-list" aria-label="Files in the zip" tabIndex={0}>
          {entries.slice(0, 300).map((entry, index) => (
            <li
              key={`${entry.path}:${index}`}
              className={entry.action === 'skip' ? 'is-skipped' : ''}
            >
              <span className="kn-zip-name">{entry.path}</span>
              <span className="kn-muted">
                {entry.action === 'skip'
                  ? `skipped: ${entry.reason ?? ''}`
                  : formatBytes(entry.size)}
              </span>
            </li>
          ))}
          {(entries.length > 300 || more) && <li className="kn-muted">and more…</li>}
        </ul>
        <div className="kn-actions">
          <button type="submit" className="kn-primary" disabled={mode === 'unzip' && !valid}>
            {mode === 'unzip' ? 'Unzip' : 'Keep as a zip'}
          </button>
          <button type="button" onClick={() => decision.resolve({ mode: 'skip' })}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}

function ClashDialog({ decision }: { decision: Extract<Decision, { kind: 'clash' }> }) {
  const [all, setAll] = useState(false)
  const first = decision.existing[0]
  const many = decision.existing.length > 1
  return (
    <Modal
      title={
        many
          ? 'Some names already exist'
          : `“${first?.path.split('/').pop() ?? decision.name}” already exists`
      }
      onClose={() => decision.resolve({ choice: 'skip', all: false })}
    >
      {many ? (
        <ul className="kn-zip-list" aria-label="Names that already exist" tabIndex={0}>
          {decision.existing.map((item) => (
            <li key={item.path}>
              <span className="kn-zip-name">{item.path}</span>
              <span className="kn-muted">from {day(item.mtime)}</span>
            </li>
          ))}
        </ul>
      ) : (
        first && (
          <p className="kn-muted">
            <code>{first.path}</code> is already in Knowledge (from {day(first.mtime)},{' '}
            {formatBytes(first.size)}).
          </p>
        )
      )}
      <div className="kn-actions kn-actions--stack">
        <button
          type="button"
          className="kn-primary"
          onClick={() => decision.resolve({ choice: 'keep', all })}
        >
          Keep both
        </button>
        <button type="button" onClick={() => decision.resolve({ choice: 'replace', all })}>
          Replace{first ? ` (existing from ${day(first.mtime)})` : ''}
        </button>
        <button type="button" onClick={() => decision.resolve({ choice: 'skip', all: false })}>
          Skip
        </button>
      </div>
      {decision.remaining > 0 && (
        <label className="kn-check">
          <input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} />
          Do this for the remaining {decision.remaining}{' '}
          {decision.remaining === 1 ? 'file' : 'files'}
        </label>
      )}
    </Modal>
  )
}

/** The one-line result of an upload run, for a banner or a notice. */
export function summaryText(summary: UploadSummary): string {
  const parts: string[] = []
  if (summary.saved.length > 0)
    parts.push(
      summary.saved.length === 1
        ? `Added ${summary.saved[0]}${summary.saved[0]!.includes('/') ? '' : ' at the top level'}`
        : `Added ${summary.saved.length} files`,
    )
  for (const unzipped of summary.unzipped)
    parts.push(
      `Unzipped ${unzipped.count} ${unzipped.count === 1 ? 'file' : 'files'} into ${unzipped.folder}` +
        (unzipped.skipped > 0 ? ` (${unzipped.skipped} skipped)` : ''),
    )
  if (summary.problems.length > 0) parts.push(`Not added: ${summary.problems.join('; ')}`)
  return parts.join('. ') + (parts.length > 0 ? '.' : '')
}
