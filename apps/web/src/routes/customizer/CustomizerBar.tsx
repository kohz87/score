import { useRef, type Dispatch, type SetStateAction } from 'react'
import type { UploadProgress as Progress } from '../../data/api.ts'
import { UploadProgress } from '../../components/UploadProgress.tsx'
import {
  canRedo,
  canUndo,
  discard,
  redo,
  undo,
  type Draft,
  type History,
} from '../../themes/customizer/draft.ts'
import { Link } from '../../shell/framed-paths.tsx'
import type { SaveProblem } from '../../themes/customizer/api.ts'
import { Segmented } from './controls.tsx'
import type { Busy, Pane, Target } from './customizer-types.ts'

type BarProps = {
  draft: Draft
  history: History
  dirty: boolean
  target: Target
  busy: Busy
  inUseNote: string
  status: string
  sent: Progress | null
  problem: SaveProblem | null
  pane: Pane
  setPane: (pane: Pane) => void
  setHistory: Dispatch<SetStateAction<History | null>>
  setStatus: (status: string) => void
  setSaveAs: (value: string | null) => void
  save: () => void
  exportZip: () => void
  pickFile: (file: File | undefined) => void
}

export function CustomizerBar({
  draft,
  history,
  dirty,
  target,
  busy,
  inUseNote,
  status,
  sent,
  problem,
  pane,
  setPane,
  setHistory,
  setStatus,
  setSaveAs,
  save,
  exportZip,
  pickFile,
}: BarProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  return (
    <>
      <header className="cz-bar">
        <Link className="cz-crumb cz-back" to="/settings/look" data-protected="raised">
          Look
        </Link>
        <span className="cz-slash" aria-hidden="true">
          /
        </span>
        <h2 className="cz-title">Customizer</h2>
        <p className="cz-editing">
          <small>Editing</small>
          <span>{draft.manifest.name}</span>
        </p>
        {dirty && <span className="cz-unsaved">Unsaved changes</span>}
        {!dirty && !target.exists && <span className="cz-unsaved">Not saved yet</span>}
      </header>

      <div className="cz-actions-wrap">
        <div className="cz-actions" role="toolbar" aria-label="Theme actions">
          <button
            type="button"
            className="cz-btn"
            disabled={!canUndo(history)}
            onClick={() => setHistory(undo(history))}
          >
            Undo
          </button>
          <button
            type="button"
            className="cz-btn"
            disabled={!canRedo(history)}
            onClick={() => setHistory(redo(history))}
          >
            Redo
          </button>
          <button
            type="button"
            className="cz-btn"
            disabled={!dirty}
            onClick={() => {
              setHistory(discard(history))
              setStatus('Went back to the saved theme. Undo brings your changes back.')
            }}
          >
            Discard
          </button>
          <span className="cz-sep" aria-hidden="true" />
          <button
            type="button"
            className="cz-btn cz-btn--primary"
            disabled={!(dirty || !target.exists) || !!busy}
            aria-describedby={inUseNote ? 'cz-inuse' : undefined}
            onClick={save}
          >
            {busy === 'save' ? 'Saving…' : inUseNote ? 'Save and apply' : 'Save'}
          </button>
          <button
            type="button"
            className="cz-btn"
            disabled={!!busy}
            onClick={() => setSaveAs(`${draft.manifest.name} copy`.slice(0, 60))}
          >
            Save as new…
          </button>
          <span className="cz-sep" aria-hidden="true" />
          <button type="button" className="cz-btn" disabled={!!busy} onClick={exportZip}>
            Export
          </button>
          <button
            type="button"
            className="cz-btn"
            disabled={!!busy}
            onClick={() => fileInput.current?.click()}
          >
            Import…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            hidden
            aria-label="Theme file to import"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              void pickFile(file)
            }}
          />
        </div>
        {inUseNote && (
          <p className="cz-inuse" id="cz-inuse">
            {inUseNote}
          </p>
        )}
      </div>

      <div className="cz-messages">
        {sent ? (
          <UploadProgress progress={sent} after="Installing…" />
        ) : (
          <p className="cz-status" role="status">
            {status}
          </p>
        )}
        {problem && (
          <p className="cz-problem" role="alert">
            {problem.text}
            {problem.kind === 'conflict' && (
              <>
                {' '}
                <button
                  type="button"
                  className="cz-link"
                  onClick={() => setSaveAs(`${draft.manifest.name} copy`.slice(0, 60))}
                >
                  Save as new…
                </button>
              </>
            )}
          </p>
        )}
      </div>

      <div className="cz-switch">
        <Segmented
          label="Show"
          value={pane}
          onChange={setPane}
          options={[
            { value: 'edit', label: 'Edit' },
            { value: 'preview', label: 'Preview' },
          ]}
        />
      </div>
    </>
  )
}
